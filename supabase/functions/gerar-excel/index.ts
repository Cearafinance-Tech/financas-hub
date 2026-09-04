import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import JSZip from "npm:jszip@3.10.1";
import ExcelJS from "npm:exceljs@4.4.0";

// Gera o Excel de uma empresa (DFP, consolidado) sob demanda: baixa o zip
// do ano na CVM, filtra pelo CNPJ/codigo CVM pedido e monta as abas.
// Nada e armazenado — cada requisicao refaz o download e o processamento.

const BASE_URL = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_{ano}.zip";

// DMPL fica de fora: mesmo so pra 1 empresa, descompactar o arquivo
// completo do mercado (dezenas de MB) estoura o limite de recursos da
// Edge Function antes mesmo de filtrar por CNPJ.
const DEMONSTRATIVOS: Record<string, string[]> = {
  BPA: ["BPA_con"],
  BPP: ["BPP_con"],
  DRE: ["DRE_con"],
  DFC: ["DFC_MD_con", "DFC_MI_con"],
  DVA: ["DVA_con"],
};

// Identidade CF Tech
const CF_TINTA = "FF0A0A0B";
const CF_PAPEL = "FFF5F3EF";
const CF_ROXO_PROFUNDO = "FF3B0764";
const CF_GRAFITE = "FF5A5A62";
const CF_HAIRLINE = "FFD8D4CB";

function soDigitos(t: string): string {
  return t.replace(/\D/g, "");
}

interface Linha {
  [col: string]: string;
}

function parseCsv(texto: string): { header: string[]; linhas: Linha[] } {
  const linhasTexto = texto.split("\n");
  const header = linhasTexto[0].trim().split(";");
  const linhas: Linha[] = [];
  for (let i = 1; i < linhasTexto.length; i++) {
    const l = linhasTexto[i];
    if (!l.trim()) continue;
    const cols = l.split(";");
    const obj: Linha = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = (cols[c] ?? "").trim();
    linhas.push(obj);
  }
  return { header, linhas };
}

// Normaliza pra unidade cheia (R$ 1,00): a CVM reporta em MIL ou UNIDADE
// dependendo da empresa/ano, e a planilha sempre deve sair no valor cheio.
function paraNumeroNormalizado(valor: string, escalaMoeda: string): number {
  const numero = parseFloat((valor || "0").replace(",", "."));
  return escalaMoeda === "MIL" ? numero * 1000 : numero;
}

// Constroi a tabela (linhas = contas, colunas = periodos) igual ao script python:
// BPA/BPP: coluna = DT_REFER (posicao patrimonial); demais: coluna = periodo (ini a fim).
function pivotar(linhas: Linha[], modo: "ponto" | "periodo"): { colunas: string[]; tabela: Map<string, Map<string, number>>; nomes: Map<string, string> } {
  const colunasSet = new Set<string>();
  const tabela = new Map<string, Map<string, number>>(); // cd_conta -> coluna -> valor
  const nomes = new Map<string, string>(); // cd_conta -> ds_conta

  for (const l of linhas) {
    const coluna = modo === "ponto" ? l["DT_REFER"] : `${l["DT_INI_EXERC"]} a ${l["DT_FIM_EXERC"]}`;
    colunasSet.add(coluna);
    const cdConta = l["CD_CONTA"];
    nomes.set(cdConta, l["DS_CONTA"]);
    if (!tabela.has(cdConta)) tabela.set(cdConta, new Map());
    tabela.get(cdConta)!.set(coluna, paraNumeroNormalizado(l["VL_CONTA"], l["ESCALA_MOEDA"]));
  }

  const colunas = Array.from(colunasSet).sort();
  return { colunas, tabela, nomes };
}

function estilizarAba(ws: ExcelJS.Worksheet) {
  const header = ws.getRow(1);
  header.eachCell((celula) => {
    celula.font = { name: "Calibri", bold: true, color: { argb: CF_PAPEL } };
    celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CF_ROXO_PROFUNDO } };
  });
  for (let r = 2; r <= ws.rowCount; r++) {
    const linha = ws.getRow(r);
    linha.eachCell((celula) => {
      celula.font = { name: "Calibri", color: { argb: CF_TINTA } };
      celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CF_PAPEL } };
      celula.border = { bottom: { style: "thin", color: { argb: CF_HAIRLINE } } };
    });
  }
  ws.columns.forEach((col) => {
    let max = 10;
    col.eachCell?.({ includeEmpty: true }, (celula) => {
      max = Math.max(max, String(celula.value ?? "").length + 2);
    });
    col.width = Math.min(max, 40);
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.showGridLines = false;
}

// CORS liberado (site publico, sem sessao de usuario) — necessario porque
// o navegador chama a function direto de outro dominio (GitHub Pages).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const params = new URL(req.url).searchParams;
  const cnpjOuCodigo = params.get("empresa") ?? "";
  const ano = params.get("ano") ?? String(new Date().getFullYear() - 1);
  const cnpjAlvo = soDigitos(cnpjOuCodigo);

  if (!cnpjAlvo) {
    return new Response(JSON.stringify({ erro: "informe o parametro 'empresa' (CNPJ ou codigo CVM)" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const url = BASE_URL.replace("{ano}", ano);
  const resp = await fetch(url);
  if (!resp.ok) {
    return new Response(JSON.stringify({ erro: `DFP ${ano} indisponivel: ${resp.status}` }), {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  const buf = await resp.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const workbook = new ExcelJS.Workbook();
  let nomeEmpresa: string | null = null;
  const resumoLinhas: Array<[string, string]> = [];
  let algumaAba = false;

  for (const [nomeAba, sufixos] of Object.entries(DEMONSTRATIVOS)) {
    let linhasEmpresa: Linha[] = [];
    for (const sufixo of sufixos) {
      const nomeArquivo = `dfp_cia_aberta_${sufixo}_${ano}.csv`;
      const arquivo = zip.file(nomeArquivo);
      if (!arquivo) continue;
      const texto = new TextDecoder("iso-8859-1").decode(await arquivo.async("uint8array"));
      const { linhas } = parseCsv(texto);
      const filtradas = linhas.filter((l) => soDigitos(l["CNPJ_CIA"]) === cnpjAlvo);
      if (filtradas.length > 0) {
        linhasEmpresa = filtradas;
        break;
      }
    }

    if (linhasEmpresa.length === 0) continue;
    algumaAba = true;
    if (!nomeEmpresa) nomeEmpresa = linhasEmpresa[0]["DENOM_CIA"];

    const { colunas, tabela, nomes } = pivotar(linhasEmpresa, nomeAba === "BPA" || nomeAba === "BPP" ? "ponto" : "periodo");

    const ws = workbook.addWorksheet(nomeAba);
    ws.columns = [
      { header: "CD_CONTA", key: "cd_conta" },
      { header: "DS_CONTA", key: "ds_conta" },
      ...colunas.map((c) => ({ header: c, key: c })),
    ];
    const contasOrdenadas = Array.from(tabela.keys()).sort();
    for (const cdConta of contasOrdenadas) {
      const linha: Record<string, unknown> = { cd_conta: cdConta, ds_conta: nomes.get(cdConta) };
      const valores = tabela.get(cdConta)!;
      for (const c of colunas) linha[c] = valores.get(c) ?? null;
      ws.addRow(linha);
    }
    estilizarAba(ws);
  }

  if (!algumaAba) {
    return new Response(JSON.stringify({ erro: "nenhuma demonstracao encontrada para essa empresa/ano" }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const wsResumo = workbook.addWorksheet("Resumo", undefined);
  workbook.worksheets.unshift(workbook.worksheets.pop()!); // move Resumo pra primeira posicao
  wsResumo.getCell("A1").value = "CF TECH";
  wsResumo.getCell("A1").font = { name: "Calibri", size: 18, bold: true, color: { argb: CF_TINTA } };
  wsResumo.getCell("A2").value = "HUB DE DADOS CVM";
  wsResumo.getCell("A2").font = { name: "Calibri", size: 10, color: { argb: CF_ROXO_PROFUNDO } };

  resumoLinhas.push(["Empresa", nomeEmpresa ?? ""], ["CNPJ/Codigo", cnpjOuCodigo], ["Ano de referencia", ano], ["Tipo de documento", "DFP"]);
  let linhaAtual = 4;
  for (const [campo, valor] of resumoLinhas) {
    wsResumo.getCell(`A${linhaAtual}`).value = campo;
    wsResumo.getCell(`A${linhaAtual}`).font = { name: "Calibri", bold: true, color: { argb: CF_GRAFITE } };
    wsResumo.getCell(`B${linhaAtual}`).value = valor;
    wsResumo.getCell(`B${linhaAtual}`).font = { name: "Calibri", color: { argb: CF_TINTA } };
    linhaAtual++;
  }
  wsResumo.getCell(`A${linhaAtual + 1}`).value = "Gerado por CF Tech";
  wsResumo.getCell(`A${linhaAtual + 1}`).font = { name: "Calibri", size: 9, color: { argb: CF_ROXO_PROFUNDO } };
  wsResumo.getCell(`A${linhaAtual + 2}`).value = new Date().toISOString();
  wsResumo.getCell(`A${linhaAtual + 2}`).font = { name: "Calibri", size: 9, color: { argb: CF_GRAFITE } };
  wsResumo.getColumn(1).width = 22;
  wsResumo.getColumn(2).width = 46;
  wsResumo.showGridLines = false;

  const xlsxBuffer = await workbook.xlsx.writeBuffer();

  return new Response(xlsxBuffer, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="demonstracoes_${cnpjAlvo}_${ano}.xlsx"`,
    },
  });
});
