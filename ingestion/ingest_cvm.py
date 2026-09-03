"""
Ingestao em lote dos dados publicos da CVM para o Supabase do financas-hub.

Roda via GitHub Actions (agendado). Para o mercado inteiro (todas as
companhias de uma vez, nao uma por vez):

  1. cadastro de companhias abertas -> tabela companies
  2. demonstrativos financeiros (DFP/ITR), sempre consolidado -> financial_line_items
     guarda so o exercicio ULTIMO de cada arquivo: o comparativo (PENULTIMO)
     de um ano X e o mesmo dado que ja foi gravado como ULTIMO quando o
     ano X-1 foi processado, entao repeti-lo geraria duplicidade.
  3. documentos publicados pela empresa (pacote IPE) -> ipe_documents

Valores de conta sao normalizados para unidade cheia (R$ 1,00) no momento
da gravacao (ver escala_moeda_original para o valor como a CVM reportou).

Variaveis de ambiente obrigatorias:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Variaveis opcionais:
  CVM_ANO_INICIAL   (default: ano atual - 5)
  CVM_ANO_FINAL     (default: ano atual)
"""

import io
import math
import os
import re
import zipfile
from datetime import date

import pandas as pd
import requests
from supabase import create_client

BASE_URL = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/{doc}/DADOS/{prefixo}_cia_aberta_{ano}.zip"
CADASTRO_URL = "https://dados.cvm.gov.br/dados/CIA_ABERTA/CAD/DADOS/cad_cia_aberta.csv"
IPE_URL = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/IPE/DADOS/ipe_cia_aberta_{ano}.zip"

# nome do demonstrativo (bate com o check constraint de financial_line_items) -> sufixo do arquivo no zip
DEMONSTRATIVOS = {
    "BPA": "BPA_con",
    "BPP": "BPP_con",
    "DRE": "DRE_con",
    "DFC_MD": "DFC_MD_con",
    "DFC_MI": "DFC_MI_con",
    "DMPL": "DMPL_con",
    "DVA": "DVA_con",
}

TAMANHO_LOTE = 1000


def cliente_supabase():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def only_digits(texto) -> str:
    return re.sub(r"\D", "", str(texto))


def em_lotes(itens, tamanho=TAMANHO_LOTE):
    for i in range(0, len(itens), tamanho):
        yield itens[i:i + tamanho]


def registros_sem_nan(registros: list[dict]) -> list[dict]:
    """Troca float('nan') por None (JSON nao aceita NaN; o pandas reverte
    None para NaN em colunas que passaram por .where(), entao a limpeza
    precisa acontecer depois do to_dict, nao antes)."""
    for r in registros:
        for k, v in r.items():
            if isinstance(v, float) and math.isnan(v):
                r[k] = None
    return registros


def baixar_zip(url: str) -> zipfile.ZipFile:
    print(f"Baixando: {url}")
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    return zipfile.ZipFile(io.BytesIO(resp.content))


def ingerir_cadastro(client) -> set:
    print("Baixando cadastro de companhias...")
    resp = requests.get(CADASTRO_URL, timeout=120)
    resp.raise_for_status()
    df = pd.read_csv(io.BytesIO(resp.content), sep=";", encoding="ISO-8859-1")

    df["CD_CVM"] = pd.to_numeric(df["CD_CVM"], errors="coerce")
    df = df.dropna(subset=["CD_CVM"])
    df["CD_CVM"] = df["CD_CVM"].astype(int)
    # o cadastro traz linhas duplicadas para o mesmo CD_CVM (historico de
    # cadastro); cd_cvm e chave do upsert, entao precisa ser unico no lote.
    df = df.drop_duplicates(subset=["CD_CVM"], keep="last")
    df["CNPJ_CIA"] = df["CNPJ_CIA"].apply(only_digits)
    df["DENOM_COMERC"] = df["DENOM_COMERC"].fillna(df["DENOM_SOCIAL"])

    colunas = {
        "CD_CVM": "cd_cvm",
        "CNPJ_CIA": "cnpj",
        "DENOM_COMERC": "denom_cia",
        "DENOM_SOCIAL": "denom_social",
        "SIT": "situacao",
        "CATEG_REG": "categoria_registro",
        "DT_REG": "data_registro",
        "UF": "uf",
        "SETOR_ATIV": "setor_atividade",
    }
    saida = df[list(colunas)].rename(columns=colunas)
    registros = registros_sem_nan(saida.to_dict("records"))

    total = 0
    for lote in em_lotes(registros):
        client.table("companies").upsert(lote, on_conflict="cd_cvm").execute()
        total += len(lote)
    print(f"Cadastro: {total} companhias gravadas.")
    return {r["cd_cvm"] for r in registros}


def normalizar_demonstrativo(df: pd.DataFrame, cd_cvm_validos: set) -> list[dict]:
    df = df[df["ORDEM_EXERC"].str.upper().str.replace("Ú", "U") == "ULTIMO"].copy()
    if df.empty:
        return []

    df["CD_CVM"] = pd.to_numeric(df["CD_CVM"], errors="coerce")
    df = df.dropna(subset=["CD_CVM", "VL_CONTA"])
    df["CD_CVM"] = df["CD_CVM"].astype(int)
    df = df[df["CD_CVM"].isin(cd_cvm_validos)]
    if df.empty:
        return []

    fator = df["ESCALA_MOEDA"].map({"MIL": 1000.0}).fillna(1.0)
    df["vl_conta_normalizado"] = df["VL_CONTA"].astype(float) * fator
    df["ordem_exerc"] = "ULTIMO"

    if "ST_CONTA_FIXA" in df.columns:
        df["st_conta_fixa"] = df["ST_CONTA_FIXA"].map({"S": True, "N": False})
    else:
        df["st_conta_fixa"] = None

    colunas = {
        "CD_CVM": "cd_cvm",
        "CD_CONTA": "cd_conta",
        "DS_CONTA": "ds_conta",
        "ordem_exerc": "ordem_exerc",
        "DT_REFER": "dt_refer",
        "DT_INI_EXERC": "dt_ini_exerc",
        "DT_FIM_EXERC": "dt_fim_exerc",
        "COLUNA_DF": "coluna_df",
        "vl_conta_normalizado": "vl_conta_normalizado",
        "ESCALA_MOEDA": "escala_moeda_original",
        "MOEDA": "moeda",
        "st_conta_fixa": "st_conta_fixa",
    }
    for origem in colunas:
        if origem not in df.columns:
            df[origem] = None

    saida = df[list(colunas)].rename(columns=colunas)
    # a CVM as vezes repete a mesma linha (mesmo valor) na fonte; a chave
    # abaixo espelha o indice unico da tabela e evita erro de conflito
    # duplicado dentro do mesmo lote de insert.
    chave = ["cd_cvm", "cd_conta", "ordem_exerc", "dt_refer", "dt_ini_exerc", "dt_fim_exerc", "coluna_df"]
    saida = saida.drop_duplicates(subset=chave, keep="last")
    return registros_sem_nan(saida.to_dict("records"))


def ingerir_demonstrativos(client, tipo: str, ano: int, cd_cvm_validos: set):
    prefixo = "dfp" if tipo == "DFP" else "itr"
    try:
        zf = baixar_zip(BASE_URL.format(doc=tipo, prefixo=prefixo, ano=ano))
    except requests.HTTPError as e:
        print(f"[aviso] {tipo} {ano} indisponivel: {e}")
        return

    for demonstrativo, sufixo in DEMONSTRATIVOS.items():
        nome_arquivo = f"{prefixo}_cia_aberta_{sufixo}_{ano}.csv"
        if nome_arquivo not in zf.namelist():
            continue

        with zf.open(nome_arquivo) as f:
            df = pd.read_csv(f, sep=";", encoding="ISO-8859-1", decimal=",")

        registros = normalizar_demonstrativo(df, cd_cvm_validos)

        # substitui por completo os dados dessa combinacao (evita linhas obsoletas de reprocessamentos)
        (
            client.table("financial_line_items")
            .delete()
            .eq("tipo_documento", tipo)
            .eq("ano_documento", ano)
            .eq("demonstrativo", demonstrativo)
            .execute()
        )

        for r in registros:
            r["tipo_documento"] = tipo
            r["ano_documento"] = ano
            r["demonstrativo"] = demonstrativo
            r["consolidado"] = True

        for lote in em_lotes(registros):
            client.table("financial_line_items").insert(lote).execute()

        client.table("ingestion_log").insert({
            "tipo_documento": tipo,
            "ano": ano,
            "status": "sucesso",
            "linhas_gravadas": len(registros),
            "mensagem": demonstrativo,
        }).execute()
        print(f"{tipo} {ano} {demonstrativo}: {len(registros)} linhas.")


def ingerir_ipe(client, ano: int, cd_cvm_validos: set):
    try:
        zf = baixar_zip(IPE_URL.format(ano=ano))
    except requests.HTTPError as e:
        print(f"[aviso] IPE {ano} indisponivel: {e}")
        return

    nome_arquivo = f"ipe_cia_aberta_{ano}.csv"
    if nome_arquivo not in zf.namelist():
        return

    with zf.open(nome_arquivo) as f:
        df = pd.read_csv(f, sep=";", encoding="ISO-8859-1")

    df["Codigo_CVM"] = pd.to_numeric(df["Codigo_CVM"], errors="coerce")
    df = df.dropna(subset=["Codigo_CVM"])
    df["Codigo_CVM"] = df["Codigo_CVM"].astype(int)
    df = df[df["Codigo_CVM"].isin(cd_cvm_validos)]
    df["Versao"] = pd.to_numeric(df["Versao"], errors="coerce").fillna(0).astype(int)

    colunas = {
        "Codigo_CVM": "cd_cvm",
        "Categoria": "categoria",
        "Tipo": "tipo",
        "Especie": "especie",
        "Assunto": "assunto",
        "Data_Referencia": "data_referencia",
        "Data_Entrega": "data_entrega",
        "Versao": "versao",
        "Link_Download": "link_download",
    }
    saida = df[list(colunas)].rename(columns=colunas)
    saida = saida.drop_duplicates(subset=["cd_cvm", "link_download", "versao"], keep="last")
    registros = registros_sem_nan(saida.to_dict("records"))

    total = 0
    for lote in em_lotes(registros):
        client.table("ipe_documents").upsert(lote, on_conflict="cd_cvm,link_download,versao").execute()
        total += len(lote)
    print(f"IPE {ano}: {total} documentos gravados.")


def main():
    ano_atual = date.today().year
    # os.environ.get(..., default) nao cobre string vazia: o GitHub Actions manda
    # "" (nao omite a variavel) quando um input opcional de workflow_dispatch
    # fica em branco, entao o "or" trata esse caso tambem.
    ano_inicial = int(os.environ.get("CVM_ANO_INICIAL") or ano_atual - 5)
    ano_final = int(os.environ.get("CVM_ANO_FINAL") or ano_atual)

    client = cliente_supabase()
    cd_cvm_validos = ingerir_cadastro(client)

    for ano in range(ano_inicial, ano_final + 1):
        for tipo in ("DFP", "ITR"):
            ingerir_demonstrativos(client, tipo, ano, cd_cvm_validos)
        ingerir_ipe(client, ano, cd_cvm_validos)

    print("Ingestao concluida.")


if __name__ == "__main__":
    main()
