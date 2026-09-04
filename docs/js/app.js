const SUPABASE_URL = "https://dqpycxztfmkdztwtrwns.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxcHljeHp0Zm1rZHp0d3Ryd25zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0Njc1ODAsImV4cCI6MjEwNDA0MzU4MH0.TuX0t_v6gtoQTHtdi_Jsj1PSFcJkG0HgiX8pN2OxGLk";

// Rotulos das opcoes de escala (o <option value> ja e o divisor numerico)
const ROTULO_ESCALA = {
  "1": "R$ (unidade)",
  "1000": "R$ mil",
  "1000000": "R$ milhões",
  "1000000000": "R$ bilhões",
};

// Identidade CF Tech
const CF_TINTA = "FF0A0A0B";
const CF_PAPEL = "FFF5F3EF";
const CF_ROXO_PROFUNDO = "FF3B0764";
const CF_GRAFITE = "FF5A5A62";
const CF_HAIRLINE = "FFD8D4CB";

const campoBusca = document.getElementById("campo-busca");
const listaResultados = document.getElementById("resultados");
const painelEmpresa = document.getElementById("painel-empresa");
const nomeEmpresaEl = document.getElementById("empresa-nome");
const metaEmpresaEl = document.getElementById("empresa-meta");
const seletorAnoInicial = document.getElementById("seletor-ano-inicial");
const seletorAnoFinal = document.getElementById("seletor-ano-final");
const seletorEscala = document.getElementById("seletor-escala");
const botaoGerar = document.getElementById("botao-gerar");
const rotuloBotao = botaoGerar.querySelector(".rotulo");
const statusDownload = document.getElementById("status-download");

let empresaSelecionada = null;
let debounceTimer = null;

function preencherAnos() {
  const anoAtual = new Date().getFullYear();
  for (let ano = anoAtual - 1; ano >= anoAtual - 8; ano--) {
    for (const sel of [seletorAnoInicial, seletorAnoFinal]) {
      const opt = document.createElement("option");
      opt.value = String(ano);
      opt.textContent = ano;
      sel.appendChild(opt);
    }
  }
  seletorAnoFinal.value = String(anoAtual - 1);
  seletorAnoInicial.value = String(anoAtual - 1);
}

// -------------------- Busca --------------------

async function buscarEmpresas(consulta) {
  const url = `${SUPABASE_URL}/functions/v1/buscar-empresas?q=${encodeURIComponent(consulta)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!resp.ok) throw new Error(`busca falhou (${resp.status})`);
  return resp.json();
}

function renderResultados(resultados) {
  listaResultados.innerHTML = "";
  if (resultados.length === 0) {
    listaResultados.innerHTML = '<div class="estado-mensagem">NENHUMA EMPRESA ENCONTRADA</div>';
    listaResultados.hidden = false;
    return;
  }
  for (const empresa of resultados) {
    const item = document.createElement("div");
    item.className = "resultado-item";
    const cancelada = empresa.situacao && empresa.situacao.toUpperCase() !== "ATIVO";
    item.innerHTML = `
      <span class="nome">${empresa.nome}</span>
      <span class="meta ${cancelada ? "cancelada" : ""}">${empresa.cnpj} · ${empresa.situacao || ""}</span>
    `;
    item.addEventListener("click", () => selecionarEmpresa(empresa));
    listaResultados.appendChild(item);
  }
  listaResultados.hidden = false;
}

function selecionarEmpresa(empresa) {
  empresaSelecionada = empresa;
  campoBusca.value = empresa.nome;
  listaResultados.hidden = true;
  nomeEmpresaEl.textContent = empresa.nome;
  metaEmpresaEl.textContent = `CNPJ ${empresa.cnpj} · CÓDIGO CVM ${empresa.cd_cvm} · ${empresa.situacao || ""}`;
  painelEmpresa.hidden = false;
  statusDownload.textContent = "";
  statusDownload.className = "status-download";
}

campoBusca.addEventListener("input", () => {
  const consulta = campoBusca.value.trim();
  clearTimeout(debounceTimer);
  empresaSelecionada = null;
  painelEmpresa.hidden = true;

  if (consulta.length < 2) {
    listaResultados.hidden = true;
    return;
  }

  debounceTimer = setTimeout(async () => {
    listaResultados.innerHTML = '<div class="estado-mensagem">BUSCANDO...</div>';
    listaResultados.hidden = false;
    try {
      const { resultados, erro } = await buscarEmpresas(consulta);
      if (erro) throw new Error(erro);
      renderResultados(resultados);
    } catch (e) {
      listaResultados.innerHTML = `<div class="estado-mensagem">ERRO NA BUSCA: ${e.message}</div>`;
    }
  }, 350);
});

document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".busca")) listaResultados.hidden = true;
});

// -------------------- Extracao + montagem do Excel (no navegador) --------------------

async function extrairAno(cnpj, ano) {
  const url = `${SUPABASE_URL}/functions/v1/extrair-dados?empresa=${encodeURIComponent(cnpj)}&ano=${ano}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
  const corpo = await resp.json();
  if (!resp.ok) throw new Error(corpo.erro || `falha ao extrair ${ano} (${resp.status})`);
  return corpo;
}

// Junta as contas de varios anos num unico mapa conta -> coluna -> valor.
// O mesmo periodo aparecendo em anos adjacentes (ex: 2023 como ULTIMO no
// zip de 2023 e como PENULTIMO no zip de 2024) cai na mesma coluna e so
// se sobrescreve — nao duplica.
//
// Para BPA/BPP a coluna e DT_FIM_EXERC (data do balanco), nao DT_REFER:
// DT_REFER e a data do proprio arquivo/filing e fica igual pra ULTIMO e
// PENULTIMO dentro do mesmo zip — usa-la faria as duas linhas colidirem
// na mesma coluna e uma sobrescrever a outra silenciosamente.
function pivotar(linhasPorAno, modo, divisor) {
  const colunasSet = new Set();
  const tabela = new Map();
  const nomes = new Map();

  for (const linhas of linhasPorAno) {
    for (const l of linhas) {
      const coluna = modo === "ponto" ? l.dt_fim_exerc : `${l.dt_ini_exerc} a ${l.dt_fim_exerc}`;
      colunasSet.add(coluna);
      nomes.set(l.cd_conta, l.ds_conta);
      if (!tabela.has(l.cd_conta)) tabela.set(l.cd_conta, new Map());
      tabela.get(l.cd_conta).set(coluna, l.valor / divisor);
    }
  }

  const colunas = Array.from(colunasSet).sort();
  return { colunas, tabela, nomes };
}

async function montarWorkbook(anos, respostasPorAno, escalaDivisor) {
  const workbook = new ExcelJS.Workbook();
  const definicoes = [
    { aba: "BPA", chaves: ["BPA"], modo: "ponto" },
    { aba: "BPP", chaves: ["BPP"], modo: "ponto" },
    { aba: "DRE", chaves: ["DRE"], modo: "periodo" },
    { aba: "DFC", chaves: ["DFC_MD", "DFC_MI"], modo: "periodo" },
    { aba: "DVA", chaves: ["DVA"], modo: "periodo" },
  ];

  const casasDecimais = escalaDivisor === 1 || escalaDivisor === 1000 ? 0 : 2;
  const rotuloEscala = ROTULO_ESCALA[String(escalaDivisor)];

  for (const def of definicoes) {
    const linhasPorAno = [];
    for (const ano of anos) {
      const resp = respostasPorAno.get(ano);
      if (!resp) continue;
      for (const chave of def.chaves) {
        if (resp.demonstrativos[chave]) linhasPorAno.push(resp.demonstrativos[chave]);
      }
    }
    if (linhasPorAno.length === 0) continue;

    const { colunas, tabela, nomes } = pivotar(linhasPorAno, def.modo, escalaDivisor);
    const ws = workbook.addWorksheet(def.aba);
    ws.addRow([`Valores em ${rotuloEscala}`]);
    ws.getCell("A1").font = { name: "Calibri", italic: true, size: 9, color: { argb: CF_GRAFITE } };
    ws.addRow(["CD_CONTA", "DS_CONTA", ...colunas]);

    const contasOrdenadas = Array.from(tabela.keys()).sort();
    for (const cdConta of contasOrdenadas) {
      const valores = tabela.get(cdConta);
      ws.addRow([cdConta, nomes.get(cdConta), ...colunas.map((c) => valores.get(c) ?? null)]);
    }

    estilizarAba(ws, casasDecimais);
  }

  return { workbook, algumaAba: workbook.worksheets.length > 0 };
}

// Como a linha 1 de cada aba e a nota de escala (nao o cabecalho), a
// estilizacao roda com deslocamento de 1 linha.
function estilizarAba(ws, casasDecimais) {
  const header = ws.getRow(2);
  header.eachCell((celula) => {
    celula.font = { name: "Calibri", bold: true, color: { argb: CF_PAPEL } };
    celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CF_ROXO_PROFUNDO } };
  });
  const formato = casasDecimais > 0 ? `#,##0.${"0".repeat(casasDecimais)}` : "#,##0";
  for (let r = 3; r <= ws.rowCount; r++) {
    const linha = ws.getRow(r);
    linha.eachCell((celula, col) => {
      celula.font = { name: "Calibri", color: { argb: CF_TINTA } };
      celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CF_PAPEL } };
      celula.border = { bottom: { style: "thin", color: { argb: CF_HAIRLINE } } };
      if (col > 2 && typeof celula.value === "number") celula.numFmt = formato;
    });
  }
  ws.columns.forEach((col) => {
    let max = 10;
    col.eachCell?.({ includeEmpty: true }, (celula) => {
      max = Math.max(max, String(celula.value ?? "").length + 2);
    });
    col.width = Math.min(max, 40);
  });
  ws.views = [{ state: "frozen", ySplit: 2 }];
  ws.showGridLines = false;
}

botaoGerar.addEventListener("click", async () => {
  if (!empresaSelecionada) return;
  const anoInicial = Number(seletorAnoInicial.value);
  const anoFinal = Number(seletorAnoFinal.value);
  const escalaDivisor = Number(seletorEscala.value);

  if (anoInicial > anoFinal) {
    statusDownload.className = "status-download erro";
    statusDownload.textContent = "O ano inicial não pode ser depois do ano final.";
    return;
  }

  const anos = [];
  for (let a = anoInicial; a <= anoFinal; a++) anos.push(a);

  botaoGerar.disabled = true;
  rotuloBotao.textContent = anos.length > 1 ? `BUSCANDO ${anos.length} ANOS...` : "GERANDO...";
  statusDownload.className = "status-download";
  statusDownload.textContent = "Baixando e processando dados direto da CVM — pode levar alguns segundos por ano...";

  try {
    const respostas = await Promise.all(anos.map((ano) => extrairAno(empresaSelecionada.cnpj, ano).then((r) => [ano, r]).catch((e) => [ano, { erro: e.message }])));
    const respostasPorAno = new Map();
    let nomeEmpresa = null;
    for (const [ano, resp] of respostas) {
      if (resp.erro) continue;
      respostasPorAno.set(ano, resp);
      if (!nomeEmpresa) nomeEmpresa = resp.empresa;
    }

    if (respostasPorAno.size === 0) {
      throw new Error("nenhum dos anos selecionados teve dados encontrados");
    }

    rotuloBotao.textContent = "MONTANDO PLANILHA...";
    const { workbook, algumaAba } = await montarWorkbook(anos, respostasPorAno, escalaDivisor);
    if (!algumaAba) throw new Error("nenhuma demonstração encontrada nesse período");

    const wsResumo = workbook.addWorksheet("Resumo");
    workbook.worksheets.unshift(workbook.worksheets.pop());
    wsResumo.getCell("A1").value = "CF TECH";
    wsResumo.getCell("A1").font = { name: "Calibri", size: 18, bold: true, color: { argb: CF_TINTA } };
    wsResumo.getCell("A2").value = "HUB DE DADOS CVM";
    wsResumo.getCell("A2").font = { name: "Calibri", size: 10, color: { argb: CF_ROXO_PROFUNDO } };

    const linhasResumo = [
      ["Empresa", nomeEmpresa || empresaSelecionada.nome],
      ["CNPJ", empresaSelecionada.cnpj],
      ["Período", anoInicial === anoFinal ? String(anoInicial) : `${anoInicial} a ${anoFinal}`],
      ["Tipo de documento", "DFP"],
      ["Escala de exibição", ROTULO_ESCALA[String(escalaDivisor)]],
    ];
    let linhaAtual = 4;
    for (const [campo, valor] of linhasResumo) {
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

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const periodoArquivo = anoInicial === anoFinal ? String(anoInicial) : `${anoInicial}-${anoFinal}`;
    const nomeArquivo = `demonstracoes_${empresaSelecionada.cnpj.replace(/\D/g, "")}_${periodoArquivo}.xlsx`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = nomeArquivo;
    link.click();
    URL.revokeObjectURL(link.href);
    statusDownload.textContent = `Pronto: ${nomeArquivo}`;
  } catch (e) {
    statusDownload.className = "status-download erro";
    statusDownload.textContent = `Erro: ${e.message}`;
  } finally {
    botaoGerar.disabled = false;
    rotuloBotao.textContent = "BAIXAR EXCEL";
  }
});

preencherAnos();
