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
const seletorTipo = document.getElementById("seletor-tipo");
const seletorAnoInicial = document.getElementById("seletor-ano-inicial");
const seletorAnoFinal = document.getElementById("seletor-ano-final");
const seletorEscala = document.getElementById("seletor-escala");
const avisoPeriodo = document.getElementById("aviso-periodo");
const avisoDmpl = document.getElementById("aviso-dmpl");
const botaoGerar = document.getElementById("botao-gerar");
const rotuloBotao = botaoGerar.querySelector(".rotulo");
const statusDownload = document.getElementById("status-download");

let empresaSelecionada = null;
let debounceTimer = null;

// A CVM so disponibiliza esse formato estruturado a partir de 2010 pro DFP
// e 2011 pro ITR (padrao contabil atual) — anos anteriores nao existem
// nesse layout, confirmado por tentativa direta (404).
const PRIMEIRO_ANO_POR_TIPO = { DFP: 2010, ITR: 2011 };

// Nome do demonstrativo (usado tambem como parametro da Edge Function) ->
// { aba no Excel, modo de pivo }. DMPL so existe pro DFP: o arquivo do ITR
// e um outlier de tamanho (~170MB descomprimido) que estoura o limite de
// recursos da Edge Function mesmo em streaming.
const DEMONSTRATIVOS_POR_TIPO = {
  DFP: {
    BPA: { aba: "BPA", modo: "ponto" },
    BPP: { aba: "BPP", modo: "ponto" },
    DRE: { aba: "DRE", modo: "periodo" },
    DFC_MD: { aba: "DFC", modo: "periodo" },
    DFC_MI: { aba: "DFC", modo: "periodo" },
    DVA: { aba: "DVA", modo: "periodo" },
    DMPL: { aba: "DMPL", modo: "dmpl" },
  },
  ITR: {
    BPA: { aba: "BPA", modo: "ponto" },
    BPP: { aba: "BPP", modo: "ponto" },
    DRE: { aba: "DRE", modo: "periodo" },
    DFC_MD: { aba: "DFC", modo: "periodo" },
    DFC_MI: { aba: "DFC", modo: "periodo" },
    DVA: { aba: "DVA", modo: "periodo" },
  },
};

const ROTULO_TIPO = { DFP: "DFP (anual)", ITR: "ITR (trimestral)" };

// Restringe o periodo selecionavel ao que a empresa realmente pode ter
// publicado: nao antes do ano de registro na CVM, nem antes do piso do
// tipo escolhido. So mostramos empresas ATIVAS na busca, entao o unico
// jeito do periodo ficar vazio e uma empresa registrada no ano corrente,
// ainda sem nenhuma demonstracao publicada.
//
// anoMaximo e o ano corrente, nao o anterior: o ITR publica trimestres ao
// longo do proprio ano (ex: 2T do ano corrente sai em ~agosto), entao travar
// em "ano atual - 1" escondia dados que ja existiam na CVM. Se o ano
// escolhido nao tiver nada publicado ainda pra essa empresa/demonstrativo,
// a extracao so ignora aquele ano — nao precisa adivinhar aqui.
function calcularPeriodoDisponivel(empresa, tipo) {
  const anoAtual = new Date().getFullYear();
  let anoMinimo = PRIMEIRO_ANO_POR_TIPO[tipo];
  if (empresa.data_registro) {
    const anoRegistro = Number(empresa.data_registro.slice(0, 4));
    if (Number.isFinite(anoRegistro)) anoMinimo = Math.max(anoMinimo, anoRegistro);
  }

  return { anoMinimo, anoMaximo: anoAtual };
}

function atualizarAvisoDmpl(tipo) {
  avisoDmpl.textContent =
    tipo === "DFP"
      ? "Inclui Balanço Patrimonial (Ativo/Passivo), DRE, Fluxo de Caixa, DVA e Mutações do PL, consolidado. Os valores são extraídos sempre no total original — a escala acima só muda como eles aparecem na planilha."
      : "Inclui Balanço Patrimonial (Ativo/Passivo), DRE, Fluxo de Caixa e DVA, consolidado. A Demonstração das Mutações do PL (DMPL) não está disponível para o trimestral — é um arquivo grande demais pra processar sob demanda. Os valores são extraídos sempre no total original — a escala acima só muda como eles aparecem na planilha.";
}

function atualizarAnosDisponiveis(empresa) {
  const tipo = seletorTipo.value;
  atualizarAvisoDmpl(tipo);

  const { anoMinimo, anoMaximo } = calcularPeriodoDisponivel(empresa, tipo);
  const anoInicialAnterior = seletorAnoInicial.value;
  const anoFinalAnterior = seletorAnoFinal.value;
  seletorAnoInicial.innerHTML = "";
  seletorAnoFinal.innerHTML = "";

  if (anoMaximo < anoMinimo) {
    seletorAnoInicial.disabled = true;
    seletorAnoFinal.disabled = true;
    botaoGerar.disabled = true;
    avisoPeriodo.className = "aviso-periodo sem-dados";
    avisoPeriodo.textContent = `Sem demonstrações ${ROTULO_TIPO[tipo]} disponíveis ainda para essa empresa.`;
    return;
  }

  for (let ano = anoMaximo; ano >= anoMinimo; ano--) {
    for (const sel of [seletorAnoInicial, seletorAnoFinal]) {
      const opt = document.createElement("option");
      opt.value = String(ano);
      opt.textContent = ano;
      sel.appendChild(opt);
    }
  }
  seletorAnoInicial.disabled = false;
  seletorAnoFinal.disabled = false;
  botaoGerar.disabled = false;
  // mantem a selecao anterior se ainda for valida (troca de tipo), senao usa o mais recente
  const manterInicial = anoInicialAnterior && Number(anoInicialAnterior) >= anoMinimo && Number(anoInicialAnterior) <= anoMaximo;
  const manterFinal = anoFinalAnterior && Number(anoFinalAnterior) >= anoMinimo && Number(anoFinalAnterior) <= anoMaximo;
  seletorAnoFinal.value = manterFinal ? anoFinalAnterior : String(anoMaximo);
  seletorAnoInicial.value = manterInicial ? anoInicialAnterior : String(anoMaximo);

  avisoPeriodo.className = "aviso-periodo";
  avisoPeriodo.textContent =
    anoMinimo === anoMaximo
      ? `Período disponível para essa empresa: apenas ${anoMinimo}.`
      : `Período disponível para essa empresa: ${anoMinimo}–${anoMaximo}.`;
}

seletorTipo.addEventListener("change", () => {
  if (empresaSelecionada) atualizarAnosDisponiveis(empresaSelecionada);
});

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
    item.innerHTML = `
      <span class="nome">${empresa.nome}</span>
      <span class="meta">${empresa.cnpj}</span>
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
  metaEmpresaEl.textContent = `CNPJ ${empresa.cnpj} · CÓDIGO CVM ${empresa.cd_cvm}`;
  painelEmpresa.hidden = false;
  statusDownload.textContent = "";
  statusDownload.className = "status-download";
  atualizarAnosDisponiveis(empresa);
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

// 1 chamada = 1 demonstrativo de 1 ano. Cada arquivo sozinho cabe folgado
// no limite de CPU da Edge Function, mas pedir varios de uma vez na mesma
// chamada estoura (confirmado). O navegador dispara todas em paralelo —
// anos x demonstrativos — e cada uma fica isolada com seu proprio orcamento.
async function extrairDemonstrativo(cnpj, tipo, ano, demonstrativo) {
  const url = `${SUPABASE_URL}/functions/v1/extrair-dados?empresa=${encodeURIComponent(cnpj)}&ano=${ano}&tipo=${tipo}&demonstrativo=${demonstrativo}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
  const corpo = await resp.json();
  if (!resp.ok) throw new Error(corpo.erro || `falha ao extrair ${demonstrativo} ${ano} (${resp.status})`);
  return corpo;
}

// Transforma um periodo (DT_INI_EXERC/DT_FIM_EXERC) num rotulo legivel em
// vez da data crua. O ITR traz DOIS tipos de periodo pro mesmo trimestre —
// acumulado (ex: jan-jun) e isolado (ex: abr-jun) — que terminam na mesma
// data mas nao podem ser confundidos com o mesmo rotulo, senao um
// sobrescreve o outro silenciosamente na tabela. So reconhece fronteiras de
// trimestre/ano civis (como a CVM sempre reporta); qualquer coisa fora
// desse padrao cai no fallback com a data crua.
function rotularPeriodo(dtIni, dtFim) {
  if (!dtIni || !dtFim) return dtFim || dtIni || "";
  const [anoIni, mesIni, diaIni] = dtIni.split("-").map(Number);
  const [anoFim, mesFim, diaFim] = dtFim.split("-").map(Number);
  const yy = String(anoFim).slice(-2);
  const fimStr = `${mesFim}-${diaFim}`;

  if (anoFim === anoIni && mesIni === 1 && diaIni === 1) {
    if (fimStr === "3-31") return `1T${yy}`;
    if (fimStr === "6-30") return `Acum. 1S${yy}`;
    if (fimStr === "9-30") return `Acum. 9M${yy}`;
    if (fimStr === "12-31") return String(anoFim);
  }
  if (anoFim === anoIni && mesIni === 4 && diaIni === 1 && fimStr === "6-30") return `2T${yy}`;
  if (anoFim === anoIni && mesIni === 7 && diaIni === 1 && fimStr === "9-30") return `3T${yy}`;
  if (anoFim === anoIni && mesIni === 10 && diaIni === 1 && fimStr === "12-31") return `4T${yy}`;

  return `${dtIni} a ${dtFim}`;
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
//
// A ordenacao das colunas usa a data (dt_fim + dt_ini), nao o rotulo —
// rotulos como "1T24"/"Acum. 1S24"/"2024" nao ficam em ordem cronologica
// se ordenados como texto.
function pivotar(linhasPorAno, modo, divisor) {
  const tabela = new Map();
  const nomes = new Map();
  const ordenacaoPorColuna = new Map();

  for (const linhas of linhasPorAno) {
    for (const l of linhas) {
      const coluna = modo === "ponto" ? l.dt_fim_exerc : rotularPeriodo(l.dt_ini_exerc, l.dt_fim_exerc);
      if (!ordenacaoPorColuna.has(coluna)) ordenacaoPorColuna.set(coluna, `${l.dt_fim_exerc}_${l.dt_ini_exerc ?? ""}`);
      nomes.set(l.cd_conta, l.ds_conta);
      if (!tabela.has(l.cd_conta)) tabela.set(l.cd_conta, new Map());
      tabela.get(l.cd_conta).set(coluna, l.valor / divisor);
    }
  }

  const colunas = Array.from(ordenacaoPorColuna.keys()).sort((a, b) =>
    ordenacaoPorColuna.get(a) < ordenacaoPorColuna.get(b) ? -1 : 1,
  );
  return { colunas, tabela, nomes };
}

// DMPL e uma matriz (movimento x coluna do patrimonio), nao uma serie
// temporal — so mostra o exercicio mais recente (ULTIMO), igual ao
// script Python original. Linhas = tipo de movimento (CD_CONTA/DS_CONTA),
// colunas = componente do PL (COLUNA_DF, ex: "Capital Social").
function pivotarDmpl(linhas, divisor) {
  const ultimo = linhas.filter((l) => l.ordem_exerc.toUpperCase().replace("Ú", "U") === "ULTIMO");
  const base = ultimo.length > 0 ? ultimo : linhas;

  const colunasSet = new Set();
  const tabela = new Map();
  const nomes = new Map();
  for (const l of base) {
    const coluna = l.coluna_df ?? "";
    colunasSet.add(coluna);
    nomes.set(l.cd_conta, l.ds_conta);
    if (!tabela.has(l.cd_conta)) tabela.set(l.cd_conta, new Map());
    tabela.get(l.cd_conta).set(coluna, l.valor / divisor);
  }

  const colunas = Array.from(colunasSet).sort();
  return { colunas, tabela, nomes };
}

// Agrupa as chaves de demonstrativo (BPA, BPP, DRE, DFC_MD, DFC_MI, DVA,
// DMPL) pela aba onde caem no Excel — DFC_MD e DFC_MI viram uma unica aba
// "DFC" (a empresa reporta um metodo ou outro, raramente os dois).
function agruparPorAba(tipo) {
  const porAba = new Map();
  for (const [chave, info] of Object.entries(DEMONSTRATIVOS_POR_TIPO[tipo])) {
    if (!porAba.has(info.aba)) porAba.set(info.aba, { modo: info.modo, chaves: [] });
    porAba.get(info.aba).chaves.push(chave);
  }
  return porAba;
}

async function montarWorkbook(tipo, anoInicial, anoFinal, contasPorChaveEAno, escalaDivisor) {
  const workbook = new ExcelJS.Workbook();
  const casasDecimais = escalaDivisor === 1 || escalaDivisor === 1000 ? 0 : 2;
  const rotuloEscala = ROTULO_ESCALA[String(escalaDivisor)];

  for (const [aba, def] of agruparPorAba(tipo)) {
    let colunas, tabela, nomes;

    if (def.modo === "dmpl") {
      // so o ano final, matriz nao acumula ao longo de varios anos
      const linhas = def.chaves.flatMap((chave) => contasPorChaveEAno.get(`${chave}|${anoFinal}`) ?? []);
      if (linhas.length === 0) continue;
      ({ colunas, tabela, nomes } = pivotarDmpl(linhas, escalaDivisor));
    } else {
      // Cada zip anual traz o exercicio comparativo anterior junto (ex:
      // BPA/BPP sempre tem ULTIMO + PENULTIMO). Sem esse filtro, escolher
      // "De 2023" ainda trazia uma coluna de 2022 encostada — a comparativa
      // do proprio arquivo de 2023. So mantem colunas cujo fim de exercicio
      // caia dentro do periodo pedido.
      const linhasPorAno = [];
      for (const [chaveAno, linhas] of contasPorChaveEAno) {
        const [chave] = chaveAno.split("|");
        if (!def.chaves.includes(chave) || linhas.length === 0) continue;
        const dentroDoPeriodo = linhas.filter((l) => Number((l.dt_fim_exerc || "").slice(0, 4)) >= anoInicial);
        if (dentroDoPeriodo.length > 0) linhasPorAno.push(dentroDoPeriodo);
      }
      if (linhasPorAno.length === 0) continue;
      ({ colunas, tabela, nomes } = pivotar(linhasPorAno, def.modo, escalaDivisor));
    }

    const ws = workbook.addWorksheet(aba);
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
  const tipo = seletorTipo.value;
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

  // 1 chamada por (ano x demonstrativo) — DMPL so no ano final, ja que
  // e uma matriz do exercicio mais recente, nao uma serie por ano.
  const chaves = Object.keys(DEMONSTRATIVOS_POR_TIPO[tipo]);
  const pedidos = [];
  for (const ano of anos) {
    for (const chave of chaves) {
      if (chave === "DMPL" && ano !== anoFinal) continue;
      pedidos.push({ ano, chave });
    }
  }

  botaoGerar.disabled = true;
  rotuloBotao.textContent = pedidos.length > 1 ? `BUSCANDO ${pedidos.length} ARQUIVOS...` : "GERANDO...";
  statusDownload.className = "status-download";
  statusDownload.textContent = "Baixando e processando dados direto da CVM — pode levar alguns segundos...";

  try {
    const respostas = await Promise.all(
      pedidos.map(({ ano, chave }) =>
        extrairDemonstrativo(empresaSelecionada.cnpj, tipo, ano, chave)
          .then((r) => ({ ano, chave, resp: r }))
          .catch((e) => ({ ano, chave, erro: e.message })),
      ),
    );

    const contasPorChaveEAno = new Map();
    let nomeEmpresa = null;
    let algumSucesso = false;
    for (const { ano, chave, resp, erro } of respostas) {
      if (erro) continue;
      algumSucesso = true;
      contasPorChaveEAno.set(`${chave}|${ano}`, resp.contas);
      if (!nomeEmpresa) nomeEmpresa = resp.empresa;
    }

    if (!algumSucesso) {
      throw new Error("nenhum dos anos selecionados teve dados encontrados");
    }

    rotuloBotao.textContent = "MONTANDO PLANILHA...";
    const { workbook, algumaAba } = await montarWorkbook(tipo, anoInicial, anoFinal, contasPorChaveEAno, escalaDivisor);
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
      ["Tipo de documento", ROTULO_TIPO[tipo]],
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
    const nomeArquivo = `${tipo.toLowerCase()}_${empresaSelecionada.cnpj.replace(/\D/g, "")}_${periodoArquivo}.xlsx`;
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

// -------------------- Spotlight dos pilares (avanca sozinho) --------------------

function iniciarSpotlightPilares() {
  const pilares = Array.from(document.querySelectorAll("#hero-pilares .pilar"));
  if (pilares.length === 0) return;

  const reduzMovimento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let indiceAtivo = 0;
  let temporizador = null;

  function ativar(indice) {
    indiceAtivo = indice;
    pilares.forEach((p, i) => p.classList.toggle("ativo", i === indice));
  }

  function proximo() {
    ativar((indiceAtivo + 1) % pilares.length);
  }

  function reiniciarCiclo() {
    clearInterval(temporizador);
    if (!reduzMovimento) temporizador = setInterval(proximo, 4500);
  }

  pilares.forEach((p, i) => {
    p.addEventListener("click", () => {
      ativar(i);
      reiniciarCiclo();
    });
  });

  ativar(0);
  reiniciarCiclo();
}

iniciarSpotlightPilares();
