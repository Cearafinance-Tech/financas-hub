import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Extrai as contas de uma empresa, para 1 demonstrativo de 1 periodo (DFP ou
// ITR), e devolve em JSON cru (sem pivotar, sem montar planilha). A
// montagem do Excel final — selecao de periodo (varios anos), tipo de
// documento e escala de exibicao — acontece no navegador, que nao tem o
// limite de CPU/memoria de uma Edge Function. Nada e armazenado — cada
// requisicao refaz o download e o processamento direto da CVM.
//
// Le so o arquivo especifico de dentro do zip (via diretorio central do
// proprio zip) e descompacta em stream (DecompressionStream nativo),
// processando linha a linha e descartando tudo que nao bate com o CNPJ
// procurado — nunca materializa o csv inteiro do mercado na memoria.
//
// Por que 1 demonstrativo por chamada (nao todos de uma vez): cada arquivo
// sozinho cabe folgado no limite de CPU (2s), mas a SOMA de varios na mesma
// requisicao estoura — confirmado testando BPA+BPP+DRE+DFC+DVA do ITR juntos
// (~2,9s somados) contra WORKER_RESOURCE_LIMIT. O navegador faz 1 chamada
// paralela por demonstrativo (e por ano), do mesmo jeito que ja fazia por
// ano — cada chamada fica isolada com seu proprio orcamento de CPU.
//
// DMPL do ITR fica de fora: e um outlier de tamanho (~170MB descomprimido,
// quase 3x qualquer outro arquivo problematico) que estoura o limite mesmo
// sozinho, mesmo com esse metodo em stream.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// nome do demonstrativo (como o navegador espera) -> sufixo do arquivo no zip
const DEMONSTRATIVOS_DFP: Record<string, string> = {
  BPA: "BPA_con",
  BPP: "BPP_con",
  DRE: "DRE_con",
  DFC_MD: "DFC_MD_con",
  DFC_MI: "DFC_MI_con",
  DVA: "DVA_con",
  DMPL: "DMPL_con",
};

// ITR sem DMPL (outlier de tamanho, ver nota acima)
const DEMONSTRATIVOS_ITR: Record<string, string> = {
  BPA: "BPA_con",
  BPP: "BPP_con",
  DRE: "DRE_con",
  DFC_MD: "DFC_MD_con",
  DFC_MI: "DFC_MI_con",
  DVA: "DVA_con",
};

function soDigitos(t: string): string {
  return t.replace(/\D/g, "");
}

// Le so o campo N (delimitado por ;) sem alocar um array com a linha
// inteira fatiada — a maioria das linhas nao bate com o CNPJ procurado,
// entao vale poupar essa alocacao no caminho comum (rejeicao). So faz o
// split completo quando a linha ja foi confirmada como do CNPJ certo.
function extrairCampo(linha: string, indice: number): string {
  let inicio = 0;
  let campoAtual = 0;
  for (let i = 0; i < linha.length; i++) {
    if (linha.charCodeAt(i) === 59 /* ; */) {
      if (campoAtual === indice) return linha.slice(inicio, i);
      campoAtual++;
      inicio = i + 1;
    }
  }
  return campoAtual === indice ? linha.slice(inicio) : "";
}

interface EntradaZip {
  nome: string;
  metodoCompressao: number;
  tamanhoComprimido: number;
  offsetHeaderLocal: number;
}

// Le o diretorio central do zip (indice de arquivos, fica no final do
// arquivo) sem descompactar nada ainda.
function lerDiretorioCentral(buf: Uint8Array): EntradaZip[] {
  const EOCD_SIG = 0x06054b50;
  const tamanhoMinEocd = 22;
  const janela = Math.min(buf.length, tamanhoMinEocd + 65535);
  const inicioBusca = buf.length - janela;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let posEocd = -1;
  for (let i = buf.length - tamanhoMinEocd; i >= inicioBusca; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      posEocd = i;
      break;
    }
  }
  if (posEocd === -1) throw new Error("EOCD nao encontrado — arquivo nao parece ser um zip valido");

  const tamanhoDirCentral = view.getUint32(posEocd + 12, true);
  const offsetDirCentral = view.getUint32(posEocd + 16, true);

  const entradas: EntradaZip[] = [];
  const CD_SIG = 0x02014b50;
  let p = offsetDirCentral;
  const fim = offsetDirCentral + tamanhoDirCentral;

  while (p < fim) {
    if (view.getUint32(p, true) !== CD_SIG) break;
    const metodoCompressao = view.getUint16(p + 10, true);
    const tamanhoComprimido = view.getUint32(p + 20, true);
    const tamanhoNome = view.getUint16(p + 28, true);
    const tamanhoExtra = view.getUint16(p + 30, true);
    const tamanhoComentario = view.getUint16(p + 32, true);
    const offsetHeaderLocal = view.getUint32(p + 42, true);
    const nome = new TextDecoder("utf-8").decode(buf.subarray(p + 46, p + 46 + tamanhoNome));

    entradas.push({ nome, metodoCompressao, tamanhoComprimido, offsetHeaderLocal });
    p += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }

  return entradas;
}

// A partir do header local (que precede os dados comprimidos), acha onde
// os bytes comprimidos de fato comecam.
function acharInicioDadosComprimidos(buf: Uint8Array, offsetHeaderLocal: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const LOCAL_SIG = 0x04034b50;
  if (view.getUint32(offsetHeaderLocal, true) !== LOCAL_SIG) {
    throw new Error("assinatura de header local invalida");
  }
  const tamanhoNome = view.getUint16(offsetHeaderLocal + 26, true);
  const tamanhoExtra = view.getUint16(offsetHeaderLocal + 28, true);
  return offsetHeaderLocal + 30 + tamanhoNome + tamanhoExtra;
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
  coluna_df: string | null;
  valor: number;
}

// Descompacta em stream e filtra pelo CNPJ, linha a linha, sem nunca
// materializar o csv inteiro do mercado na memoria. Devolve tambem o nome
// da empresa (extraido da mesma passada, sem reler o arquivo).
async function extrairContasDaEntrada(
  buf: Uint8Array,
  entrada: EntradaZip,
  cnpjAlvo: string,
): Promise<{ contas: ContaExtraida[]; nomeEmpresa: string | null }> {
  const inicioDados = acharInicioDadosComprimidos(buf, entrada.offsetHeaderLocal);
  const dadosComprimidos = buf.subarray(inicioDados, inicioDados + entrada.tamanhoComprimido);
  const streamBytes = new Response(dadosComprimidos).body!;

  let streamTexto: ReadableStream<string>;
  if (entrada.metodoCompressao === 0) {
    streamTexto = streamBytes.pipeThrough(new TextDecoderStream("iso-8859-1"));
  } else if (entrada.metodoCompressao === 8) {
    streamTexto = streamBytes
      .pipeThrough(new DecompressionStream("deflate-raw"))
      .pipeThrough(new TextDecoderStream("iso-8859-1"));
  } else {
    throw new Error(`metodo de compressao nao suportado: ${entrada.metodoCompressao}`);
  }

  const reader = streamTexto.getReader();
  let sobra = "";
  let idxCnpj = -1;
  let idxDenomCia = -1;
  let idxCdConta = -1;
  let idxDsConta = -1;
  let idxOrdemExerc = -1;
  let idxDtRefer = -1;
  let idxDtIniExerc = -1;
  let idxDtFimExerc = -1;
  let idxVlConta = -1;
  let idxEscalaMoeda = -1;
  let idxColunaDf = -1;
  let primeiraLinha = true;
  let nomeEmpresa: string | null = null;
  const contas: ContaExtraida[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    sobra += value;

    let idx: number;
    while ((idx = sobra.indexOf("\n")) >= 0) {
      const linha = sobra.slice(0, idx);
      sobra = sobra.slice(idx + 1);
      if (!linha) continue;

      if (primeiraLinha) {
        const header = linha.trim().split(";");
        idxCnpj = header.indexOf("CNPJ_CIA");
        idxDenomCia = header.indexOf("DENOM_CIA");
        idxCdConta = header.indexOf("CD_CONTA");
        idxDsConta = header.indexOf("DS_CONTA");
        idxOrdemExerc = header.indexOf("ORDEM_EXERC");
        idxDtRefer = header.indexOf("DT_REFER");
        idxDtIniExerc = header.indexOf("DT_INI_EXERC");
        idxDtFimExerc = header.indexOf("DT_FIM_EXERC");
        idxVlConta = header.indexOf("VL_CONTA");
        idxEscalaMoeda = header.indexOf("ESCALA_MOEDA");
        idxColunaDf = header.indexOf("COLUNA_DF");
        primeiraLinha = false;
        continue;
      }

      const campoCnpj = extrairCampo(linha, idxCnpj);
      if (soDigitos(campoCnpj) !== cnpjAlvo) continue;

      const cols = linha.split(";");
      if (!nomeEmpresa) nomeEmpresa = cols[idxDenomCia] ?? null;
      contas.push({
        cd_conta: cols[idxCdConta] ?? "",
        ds_conta: cols[idxDsConta] ?? "",
        ordem_exerc: cols[idxOrdemExerc] ?? "",
        dt_refer: cols[idxDtRefer] ?? "",
        dt_ini_exerc: cols[idxDtIniExerc] || null,
        dt_fim_exerc: cols[idxDtFimExerc] || null,
        coluna_df: idxColunaDf >= 0 ? cols[idxColunaDf] || null : null,
        valor: paraNumeroNormalizado(cols[idxVlConta] ?? "", cols[idxEscalaMoeda] ?? ""),
      });
    }
  }

  return { contas, nomeEmpresa };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const params = new URL(req.url).searchParams;
  const cnpjOuCodigo = params.get("empresa") ?? "";
  const ano = params.get("ano") ?? "";
  const tipo = (params.get("tipo") ?? "DFP").toUpperCase();
  const demonstrativo = (params.get("demonstrativo") ?? "").toUpperCase();
  const cnpjAlvo = soDigitos(cnpjOuCodigo);

  if (!cnpjAlvo || !ano || !demonstrativo) {
    return new Response(JSON.stringify({ erro: "informe 'empresa' (CNPJ ou codigo CVM), 'ano' e 'demonstrativo'" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (tipo !== "DFP" && tipo !== "ITR") {
    return new Response(JSON.stringify({ erro: "'tipo' deve ser DFP ou ITR" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const prefixo = tipo === "DFP" ? "dfp" : "itr";
  const demonstrativosMapa = tipo === "DFP" ? DEMONSTRATIVOS_DFP : DEMONSTRATIVOS_ITR;
  const sufixo = demonstrativosMapa[demonstrativo];
  if (!sufixo) {
    return new Response(
      JSON.stringify({ erro: `demonstrativo '${demonstrativo}' indisponivel para ${tipo}`, disponiveis: Object.keys(demonstrativosMapa) }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  const url = `https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/${tipo}/DADOS/${prefixo}_cia_aberta_${ano}.zip`;

  const resp = await fetch(url);
  if (!resp.ok) {
    return new Response(JSON.stringify({ erro: `${tipo} ${ano} indisponivel: ${resp.status}` }), {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  const bufArray = new Uint8Array(await resp.arrayBuffer());

  let entradasZip: EntradaZip[];
  try {
    entradasZip = lerDiretorioCentral(bufArray);
  } catch (e) {
    return new Response(JSON.stringify({ erro: `zip invalido: ${(e as Error).message}` }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const nomeArquivo = `${prefixo}_cia_aberta_${sufixo}_${ano}.csv`;
  const entrada = entradasZip.find((e) => e.nome === nomeArquivo);
  if (!entrada) {
    return new Response(JSON.stringify({ erro: `arquivo nao encontrado no zip: ${nomeArquivo}` }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let resultado: { contas: ContaExtraida[]; nomeEmpresa: string | null };
  try {
    resultado = await extrairContasDaEntrada(bufArray, entrada, cnpjAlvo);
  } catch (e) {
    return new Response(JSON.stringify({ erro: `falha extraindo/descomprimindo: ${(e as Error).message}` }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (resultado.contas.length === 0) {
    return new Response(JSON.stringify({ erro: "nenhuma demonstracao encontrada para essa empresa/ano/demonstrativo" }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ empresa: resultado.nomeEmpresa, ano, tipo, demonstrativo, contas: resultado.contas }),
    { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
});
