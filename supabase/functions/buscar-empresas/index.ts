import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Busca empresas no cadastro publico da CVM, ao vivo, sem cache: baixa o
// CSV do cadastro a cada requisicao e filtra por nome/CNPJ/codigo CVM.
const CADASTRO_URL = "https://dados.cvm.gov.br/dados/CIA_ABERTA/CAD/DADOS/cad_cia_aberta.csv";

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

function soDigitos(texto: string): string {
  return texto.replace(/\D/g, "");
}

Deno.serve(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const consulta = (params.get("q") ?? "").trim();
  const limite = Math.min(Number(params.get("limite") ?? 10), 25);

  if (consulta.length < 2) {
    return new Response(JSON.stringify({ erro: "informe ao menos 2 caracteres" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const resp = await fetch(CADASTRO_URL);
  if (!resp.ok) {
    return new Response(JSON.stringify({ erro: `cadastro CVM indisponivel: ${resp.status}` }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  const buf = await resp.arrayBuffer();
  // o cadastro vem em ISO-8859-1 (latin1), nao UTF-8
  const texto = new TextDecoder("iso-8859-1").decode(buf);

  const linhas = texto.split("\n");
  const cabecalho = linhas[0].split(";");
  const idx = {
    cnpj: cabecalho.indexOf("CNPJ_CIA"),
    denomSocial: cabecalho.indexOf("DENOM_SOCIAL"),
    denomComerc: cabecalho.indexOf("DENOM_COMERC"),
    cdCvm: cabecalho.indexOf("CD_CVM"),
    sit: cabecalho.indexOf("SIT"),
  };

  const consultaDigitos = soDigitos(consulta);
  const buscaPorCnpjOuCodigo = consultaDigitos.length >= 4;
  const consultaNorm = normalizar(consulta);

  const vistos = new Set<string>();
  const resultados: Array<{ cd_cvm: number; cnpj: string; nome: string; situacao: string }> = [];

  for (let i = 1; i < linhas.length && resultados.length < limite; i++) {
    const linha = linhas[i];
    if (!linha) continue;
    const cols = linha.split(";");
    const cdCvm = cols[idx.cdCvm];
    if (!cdCvm || vistos.has(cdCvm)) continue;

    const nome = cols[idx.denomComerc] || cols[idx.denomSocial] || "";
    const cnpj = cols[idx.cnpj] || "";

    let bate = false;
    if (buscaPorCnpjOuCodigo) {
      bate = soDigitos(cnpj).includes(consultaDigitos) || cdCvm.includes(consultaDigitos);
    } else {
      bate = normalizar(nome).includes(consultaNorm);
    }

    if (bate) {
      vistos.add(cdCvm);
      resultados.push({
        cd_cvm: Number(cdCvm),
        cnpj,
        nome,
        situacao: cols[idx.sit] || "",
      });
    }
  }

  return new Response(JSON.stringify({ resultados }), {
    headers: { "Content-Type": "application/json" },
  });
});
