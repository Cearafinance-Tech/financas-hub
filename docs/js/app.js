const SUPABASE_URL = "https://dqpycxztfmkdztwtrwns.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxcHljeHp0Zm1rZHp0d3Ryd25zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0Njc1ODAsImV4cCI6MjEwNDA0MzU4MH0.TuX0t_v6gtoQTHtdi_Jsj1PSFcJkG0HgiX8pN2OxGLk";

const campoBusca = document.getElementById("campo-busca");
const listaResultados = document.getElementById("resultados");
const painelEmpresa = document.getElementById("painel-empresa");
const nomeEmpresaEl = document.getElementById("empresa-nome");
const metaEmpresaEl = document.getElementById("empresa-meta");
const seletorAno = document.getElementById("seletor-ano");
const botaoGerar = document.getElementById("botao-gerar");
const statusDownload = document.getElementById("status-download");

let empresaSelecionada = null;
let debounceTimer = null;

function preencherAnos() {
  const anoAtual = new Date().getFullYear();
  for (let ano = anoAtual - 1; ano >= anoAtual - 6; ano--) {
    const opt = document.createElement("option");
    opt.value = String(ano);
    opt.textContent = ano;
    seletorAno.appendChild(opt);
  }
}

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

botaoGerar.addEventListener("click", async () => {
  if (!empresaSelecionada) return;
  const ano = seletorAno.value;
  botaoGerar.disabled = true;
  botaoGerar.textContent = "GERANDO...";
  statusDownload.className = "status-download";
  statusDownload.textContent = "Baixando e processando dados direto da CVM — pode levar alguns segundos...";

  try {
    const url = `${SUPABASE_URL}/functions/v1/gerar-excel?empresa=${encodeURIComponent(empresaSelecionada.cnpj)}&ano=${ano}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!resp.ok) {
      const corpo = await resp.json().catch(() => ({}));
      throw new Error(corpo.erro || `falha ao gerar (${resp.status})`);
    }
    const blob = await resp.blob();
    const nomeArquivo = `demonstracoes_${empresaSelecionada.cnpj.replace(/\D/g, "")}_${ano}.xlsx`;
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
    botaoGerar.textContent = "BAIXAR EXCEL";
  }
});

preencherAnos();
