import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import JSZip from "npm:jszip@3.10.1";

// Extrai as contas de uma empresa, para 1 ano do DFP, e devolve em JSON cru
// (sem pivotar, sem montar planilha). A montagem do Excel final — incluindo
// selecao de periodo (varios anos) e escala de exibicao — acontece no
// navegador, que nao tem o limite de CPU de uma Edge Function. Buscar mais
// de 1 ano dentro da mesma requisicao no servidor estoura esse limite.
//
// Nada e armazenado — cada requisicao refaz o download e o processamento.

const BASE_URL = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_{ano}.zip";

// DMPL fica de fora: mesmo so pra 1 empresa, descompactar o arquivo
// completo do mercado (dezenas de MB) estoura o limite de recursos da
// Edge Function antes mesmo de filtrar por CNPJ.
const DEMONSTRATIVOS: Record<string, string[]> = {
  BPA: ["BPA_con"],
  BPP: ["BPP_con"],
  DRE: ["DRE_con"],
  DFC_MD: ["DFC_MD_con"],
  DFC_MI: ["DFC_MI_con"],
  DVA: ["DVA_con"],
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function soDigitos(t: string): string {
  return t.replace(/\D/g, "");
}

interface Linha {
  [col: string]: string;
}

function parseCsv(texto: string): Linha[] {
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
  return linhas;
}

// Sempre normalizado pra unidade cheia (R$ 1,00) — nunca abreviado aqui.
// A CVM reporta em MIL ou UNIDADE dependendo da empresa/ano; a abreviacao
// pra exibicao (Mil/Milhao/Bilhao) e responsabilidade exclusiva do
// navegador, na hora de montar a planilha.
function paraNumeroNormalizado(valor: string, escalaMoeda: string): number {
  const numero = parseFloat((valor || "0").replace(",", "."));
  return escalaMoeda === "MIL" ? numero * 1000 : numero;
}

interface ContaExtraida {
  cd_conta: string;
  ds_conta: string;
  ordem_exerc: string;
  dt_refer: string;
  dt_ini_exerc: string | null;
  dt_fim_exerc: string | null;
  valor: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const params = new URL(req.url).searchParams;
  const cnpjOuCodigo = params.get("empresa") ?? "";
  const ano = params.get("ano") ?? "";
  const cnpjAlvo = soDigitos(cnpjOuCodigo);

  if (!cnpjAlvo || !ano) {
    return new Response(JSON.stringify({ erro: "informe 'empresa' (CNPJ ou codigo CVM) e 'ano'" }), {
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

  let nomeEmpresa: string | null = null;
  const demonstrativos: Record<string, ContaExtraida[]> = {};

  for (const [nomeDemo, sufixos] of Object.entries(DEMONSTRATIVOS)) {
    for (const sufixo of sufixos) {
      const nomeArquivo = `dfp_cia_aberta_${sufixo}_${ano}.csv`;
      const arquivo = zip.file(nomeArquivo);
      if (!arquivo) continue;
      const texto = new TextDecoder("iso-8859-1").decode(await arquivo.async("uint8array"));
      const linhas = parseCsv(texto).filter((l) => soDigitos(l["CNPJ_CIA"]) === cnpjAlvo);
      if (linhas.length === 0) continue;

      if (!nomeEmpresa) nomeEmpresa = linhas[0]["DENOM_CIA"];
      demonstrativos[nomeDemo] = linhas.map((l) => ({
        cd_conta: l["CD_CONTA"],
        ds_conta: l["DS_CONTA"],
        ordem_exerc: l["ORDEM_EXERC"],
        dt_refer: l["DT_REFER"],
        dt_ini_exerc: l["DT_INI_EXERC"] || null,
        dt_fim_exerc: l["DT_FIM_EXERC"] || null,
        valor: paraNumeroNormalizado(l["VL_CONTA"], l["ESCALA_MOEDA"]),
      }));
      break;
    }
  }

  if (!nomeEmpresa) {
    return new Response(JSON.stringify({ erro: "nenhuma demonstracao encontrada para essa empresa/ano" }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ empresa: nomeEmpresa, ano, demonstrativos }), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
});
