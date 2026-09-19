const express = require("express");
const cors = require("cors");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const ExcelJS = require("exceljs");

const app = express();

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.use(cors());
app.use(express.json());

const upload = multer({
    dest: "uploads/",
    limits: {
        fileSize: 50 * 1024 * 1024
    }
});

const extensoesImagem = [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp"
];

if (!process.env.GEMINI_API_KEY) {
    console.error(
        "ERRO: GEMINI_API_KEY não foi configurada."
    );
}

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});


/* =========================================================
   ROTA DE TESTE
========================================================= */

app.get("/", (req, res) => {
    res.json({
        status: "ok",
        mensagem: "Backend do Digitalizar Tabela está funcionando."
    });
});


/* =========================================================
   PROCESSAMENTO DO ZIP
========================================================= */

app.post(
    "/processar",
    upload.single("arquivo"),
    async (req, res) => {

        let caminhoZip = null;
        let pastaTemporaria = null;

        try {

            /* ---------------------------------------------
               Verifica se recebeu arquivo
            --------------------------------------------- */

            if (!req.file) {
                return res.status(400).json({
                    erro: "Nenhum arquivo foi enviado."
                });
            }

            caminhoZip = req.file.path;


            /* ---------------------------------------------
               Verifica se é ZIP
            --------------------------------------------- */

            const extensaoArquivo = path
                .extname(req.file.originalname)
                .toLowerCase();

            if (extensaoArquivo !== ".zip") {

                removerArquivo(caminhoZip);

                caminhoZip = null;

                return res.status(400).json({
                    erro: "O arquivo enviado precisa ser um ZIP."
                });
            }


            /* ---------------------------------------------
               Cria pasta temporária
            --------------------------------------------- */

            pastaTemporaria = path.join(
                "uploads",
                `processamento-${Date.now()}`
            );

            fs.mkdirSync(
                pastaTemporaria,
                {
                    recursive: true
                }
            );


            /* ---------------------------------------------
               Extrai ZIP
            --------------------------------------------- */

            console.log("Extraindo ZIP...");

            const zip = new AdmZip(caminhoZip);

            zip.extractAllTo(
                pastaTemporaria,
                true
            );


            /* ---------------------------------------------
               Procura imagens
            --------------------------------------------- */

            const imagens = encontrarImagens(
                pastaTemporaria
            );

            if (imagens.length === 0) {

                return res.status(400).json({
                    erro:
                        "Nenhuma imagem foi encontrada dentro do ZIP."
                });
            }

            console.log(
                `Imagens encontradas: ${imagens.length}`
            );


            /* ---------------------------------------------
               Monta conteúdo para o Gemini
            --------------------------------------------- */

            const contents = [];

            contents.push({
                text: `
Você está analisando um conjunto de fotografias de tabelas.

Analise TODAS as imagens em conjunto.

Cada imagem representa uma tabela ou parte de uma tabela.

Para cada imagem:

- identifique os produtos;
- identifique os valores associados aos produtos;
- preserve exatamente o nome dos produtos quando possível;
- quando uma célula estiver vazia, use null;
- não invente valores;
- considere que imagens diferentes podem conter informações complementares.

IMPORTANTE:

Ainda não altere nem crie nenhuma planilha.

Neste momento, apenas extraia e organize os dados encontrados nas imagens.

Retorne somente JSON válido no formato solicitado.
                `.trim()
            });


            /* ---------------------------------------------
               Adiciona imagens
            --------------------------------------------- */

            for (const imagem of imagens) {

                console.log(
                    `Adicionando imagem: ${imagem.nome}`
                );

                const dadosImagem = fs.readFileSync(
                    imagem.caminho
                );

                const base64 = dadosImagem.toString(
                    "base64"
                );

                contents.push({
                    text:
                        `Imagem: ${imagem.nome}`
                });

                contents.push({
                    inlineData: {
                        mimeType:
                            obterMimeType(
                                imagem.caminho
                            ),
                        data: base64
                    }
                });
            }


            /* ---------------------------------------------
               Envia para Gemini
            --------------------------------------------- */

            console.log(
                "Enviando imagens para o Gemini..."
            );

            const resposta =
                await ai.models.generateContent({

                    model: "gemini-3.8-flash",

                    contents: contents,

                    config: {

                        responseMimeType:
                            "application/json",

                        responseSchema: {

                            type: "object",

                            properties: {

                                tabelas: {

                                    type: "array",

                                    items: {

                                        type: "object",

                                        properties: {

                                            imagem: {
                                                type: "string"
                                            },

                                            produtos: {

                                                type: "array",

                                                items: {

                                                    type: "object",

                                                    properties: {

                                                        produto: {
                                                            type: "string"
                                                        },

                                                        valor: {

                                                            type: [
                                                                "number",
                                                                "null"
                                                            ]

                                                        }

                                                    },

                                                    required: [
                                                        "produto",
                                                        "valor"
                                                    ]

                                                }

                                            }

                                        },

                                        required: [
                                            "imagem",
                                            "produtos"
                                        ]

                                    }

                                }

                            },

                            required: [
                                "tabelas"
                            ]

                        }

                    }

                });


            console.log(
                "Resposta recebida do Gemini."
            );


            /* ---------------------------------------------
               Converte resposta para JSON
            --------------------------------------------- */

            let resultado;

            try {

                resultado = JSON.parse(
                    resposta.text
                );

            } catch (erro) {

                console.error(
                    "Resposta recebida do Gemini:"
                );

                console.error(
                    resposta.text
                );

                return res.status(500).json({

                    erro:
                        "O Gemini retornou uma resposta que não pôde ser convertida em JSON.",

                    respostaGemini:
                        resposta.text

                });

            }


            /* ---------------------------------------------
               Combina tabelas complementares
            --------------------------------------------- */

            const combinacoes = combinarTabelas(
                resultado.tabelas
            );

            console.log(
                "Combinações encontradas:"
            );

            console.log(
                JSON.stringify(
                    combinacoes,
                    null,
                    2
                )
            );

            resultado.combinacoes = combinacoes;


            /* ---------------------------------------------
               Gera Excel
            --------------------------------------------- */

            console.log(
                "Gerando arquivo Excel..."
            );

            const arquivoExcel =
                await gerarExcel(
                    resultado.combinacoes
                );

            const nomeArquivo =
                `tabela-digitalizada-${Date.now()}.xlsx`;

            resultado.arquivoExcel = {
                nome: nomeArquivo,
                base64:
                    arquivoExcel.toString(
                        "base64"
                    )
            };


            /* ---------------------------------------------
               Retorna resultado
            --------------------------------------------- */

            return res.json({

                sucesso: true,

                quantidadeImagens:
                    imagens.length,

                dados:
                    resultado

            });


        } catch (erro) {

    console.error(
        "========================================"
    );

    console.error(
        "ERRO COMPLETO DURANTE O PROCESSAMENTO"
    );

    console.error(
        "========================================"
    );

    console.error(
        "Mensagem:",
        erro?.message
    );

    console.error(
        "Nome:",
        erro?.name
    );

    console.error(
        "Status:",
        erro?.status
    );

    console.error(
        "Código:",
        erro?.code
    );

    console.error(
        "Detalhes:",
        erro?.details
    );

    console.error(
        "Stack:",
        erro?.stack
    );

    console.error(
        "Objeto completo:",
        JSON.stringify(
            erro,
            Object.getOwnPropertyNames(erro),
            2
        )
    );

    return res.status(500).json({

        erro:
            "Erro ao processar o arquivo.",

        detalhes:
            erro?.message ||
            String(erro),

        nome:
            erro?.name,

        status:
            erro?.status,

        codigo:
            erro?.code

    });

} finally {


            /* ---------------------------------------------
               Remove ZIP temporário
            --------------------------------------------- */

            if (
                caminhoZip &&
                fs.existsSync(caminhoZip)
            ) {

                removerArquivo(
                    caminhoZip
                );

            }


            /* ---------------------------------------------
               Remove pasta temporária
            --------------------------------------------- */

            if (
                pastaTemporaria &&
                fs.existsSync(pastaTemporaria)
            ) {

                try {

                    fs.rmSync(
                        pastaTemporaria,
                        {
                            recursive: true,
                            force: true
                        }
                    );

                } catch (erro) {

                    console.error(
                        "Não foi possível remover a pasta temporária:",
                        erro.message
                    );

                }

            }

        }

    }
);


/* =========================================================
   FUNÇÃO: GERAR EXCEL
========================================================= */

async function gerarExcel(combinacoes) {

    const workbook =
        new ExcelJS.Workbook();

    const worksheet =
        workbook.addWorksheet(
            "Planilha1"
        );


    /*
       Produtos aparecem na ordem em que são encontrados
       nas combinações.
    */

    const produtos = [];

    for (
        const combinacao of combinacoes
    ) {

        for (
            const item of combinacao.produtos
        ) {

            const chave =
                normalizarProduto(
                    item.produto
                );

            const jaExiste =
                produtos.some(
                    (produto) =>
                        normalizarProduto(
                            produto
                        ) === chave
                );

            if (!jaExiste) {

                produtos.push(
                    item.produto
                );

            }

        }

    }


    /*
       Cria o cabeçalho:
       Produto | Valor 1 | Valor 2 | Valor 3...
    */

    const cabecalho = [
        "Produto",
        ...combinacoes.map(
            (combinacao) =>
                combinacao.valor
        )
    ];

    worksheet.addRow(
        cabecalho
    );


    /*
       Cria um mapa para localizar rapidamente
       o valor de cada produto em cada combinação.
    */

    const mapasPorCombinacao =
        combinacoes.map(
            (combinacao) => {

                const mapa =
                    new Map();

                for (
                    const item of combinacao.produtos
                ) {

                    mapa.set(
                        normalizarProduto(
                            item.produto
                        ),
                        item.valor
                    );

                }

                return mapa;

            }
        );


    /*
       Preenche as linhas dos produtos.
    */

    for (
        const produto of produtos
    ) {

        const chave =
            normalizarProduto(
                produto
            );

        const linha = [
            produto
        ];

        for (
            const mapa of mapasPorCombinacao
        ) {

            const valor =
                mapa.get(chave);

            linha.push(
                valor === null ||
                valor === undefined
                    ? ""
                    : valor
            );

        }

        worksheet.addRow(
            linha
        );

    }


    /*
       Ajusta largura das colunas.
    */

    worksheet.columns.forEach(
        (coluna, indice) => {

            let largura = 12;

            for (
                const celula of coluna.values
            ) {

                if (
                    celula !== null &&
                    celula !== undefined
                ) {

                    largura =
                        Math.max(
                            largura,
                            String(
                                celula
                            ).length + 2
                        );

                }

            }

            coluna.width =
                indice === 0
                    ? Math.max(
                        largura,
                        20
                    )
                    : Math.min(
                        Math.max(
                            largura,
                            12
                        ),
                        20
                    );

        }
    );


    /*
       Congela a primeira linha.
    */

    worksheet.views = [
        {
            state: "frozen",
            ySplit: 1
        }
    ];


    /*
       Formatação básica do cabeçalho.
    */

    const primeiraLinha =
        worksheet.getRow(1);

    primeiraLinha.font = {
        bold: true
    };

    primeiraLinha.alignment = {
        vertical: "middle",
        horizontal: "center"
    };


    /*
       Valores numéricos ficam como números
       no Excel.
    */

    for (
        let linha = 2;
        linha <= worksheet.rowCount;
        linha++
    ) {

        for (
            let coluna = 2;
            coluna <= worksheet.columnCount;
            coluna++
        ) {

            const celula =
                worksheet.getCell(
                    linha,
                    coluna
                );

            if (
                typeof celula.value === "number" &&
                Number.isFinite(celula.value)
            ) {
    
                celula.numFmt = "0";
            }

        }

    }


    return Buffer.from(
        await workbook.xlsx.writeBuffer()
    );

}


/* =========================================================
   FUNÇÃO: COMBINAR TABELAS
========================================================= */

function combinarTabelas(tabelas) {

    if (
        !Array.isArray(tabelas) ||
        tabelas.length === 0
    ) {
        return [];
    }


    const tabelasValidas =
        tabelas
            .map(
                (tabela, indice) => {

                    const produtos =
                        Array.isArray(
                            tabela.produtos
                        )
                            ? tabela.produtos
                            : [];

                    const produtosNormalizados =
                        produtos.map(
                            (item) => ({

                                produto:
                                    normalizarProduto(
                                        item.produto
                                    ),

                                produtoOriginal:
                                    item.produto,

                                valor:
                                    item.valor

                            })
                        );

                    const possuiValor =
                        produtosNormalizados.some(
                            (item) =>
                                item.valor !== null &&
                                item.valor !== undefined
                        );

                    return {

                        indiceOriginal:
                            indice,

                        imagem:
                            tabela.imagem,

                        produtos:
                            produtosNormalizados,

                        possuiValor

                    };

                }
            )
            .filter(
                (tabela) =>
                    tabela.possuiValor
            );


    const grupos = [];


    for (
        const tabela of tabelasValidas
    ) {

        let grupoEncontrado =
            false;


        for (
            const grupo of grupos
        ) {

            if (
                podeCombinar(
                    grupo.produtos,
                    tabela.produtos
                )
            ) {

                grupo.produtos =
                    preencherNulos(
                        grupo.produtos,
                        tabela.produtos
                    );

                grupo.imagens.push(
                    tabela.imagem
                );

                grupo.indicesOriginais.push(
                    tabela.indiceOriginal
                );

                grupoEncontrado =
                    true;

                break;
            }

        }


        if (
            !grupoEncontrado
        ) {

            grupos.push({

                imagens: [
                    tabela.imagem
                ],

                indicesOriginais: [
                    tabela.indiceOriginal
                ],

                produtos:
                    tabela.produtos.map(
                        (item) => ({

                            produto:
                                item.produto,

                            produtoOriginal:
                                item.produtoOriginal,

                            valor:
                                item.valor

                        })
                    )

            });

        }

    }


    return grupos.map(
        (grupo, indice) => ({

            valor:
                `Valor ${indice + 1}`,

            imagens:
                grupo.imagens,

            produtos:
                grupo.produtos.map(
                    (item) => ({

                        produto:
                            item.produtoOriginal,

                        valor:
                            item.valor

                    })
                )

        })
    );

}


/* =========================================================
   FUNÇÃO: VERIFICA SE DUAS TABELAS PODEM SER COMBINADAS
========================================================= */

function podeCombinar(
    base,
    candidata
) {

    for (
        const itemCandidato of candidata
    ) {

        if (
            itemCandidato.valor === null ||
            itemCandidato.valor === undefined
        ) {

            continue;

        }


        const itemBase =
            base.find(
                (item) =>
                    normalizarProduto(
                        item.produto
                    ) ===
                    normalizarProduto(
                        itemCandidato.produto
                    )
            );


        if (
            !itemBase
        ) {

            return false;

        }


        if (
            itemBase.valor !== null &&
            itemBase.valor !== undefined
        ) {

            return false;

        }

    }


    return true;

}


/* =========================================================
   FUNÇÃO: PREENCHE OS NULLS DA TABELA BASE
========================================================= */

function preencherNulos(
    base,
    candidata
) {

    return base.map(
        (itemBase) => {

            const itemCandidato =
                candidata.find(
                    (item) =>
                        normalizarProduto(
                            item.produto
                        ) ===
                        normalizarProduto(
                            itemBase.produto
                        )
                );


            if (
                itemBase.valor === null &&
                itemCandidato &&
                itemCandidato.valor !== null &&
                itemCandidato.valor !== undefined
            ) {

                return {

                    produto:
                        itemBase.produto,

                    produtoOriginal:
                        itemBase.produtoOriginal,

                    valor:
                        itemCandidato.valor

                };

            }


            return itemBase;

        }
    );

}


/* =========================================================
   FUNÇÃO: NORMALIZA NOME DO PRODUTO
========================================================= */

function normalizarProduto(
    produto
) {

    if (
        produto === null ||
        produto === undefined
    ) {

        return "";

    }

    return String(
        produto
    )
        .normalize("NFD")
        .replace(
            /[\u0300-\u036f]/g,
            ""
        )
        .trim()
        .toLowerCase()
        .replace(
            /\s+/g,
            " "
        );

}


/* =========================================================
   FUNÇÃO: ENCONTRAR IMAGENS
========================================================= */

function encontrarImagens(
    pasta
) {

    const resultado = [];

    const itens =
        fs.readdirSync(
            pasta,
            {
                withFileTypes: true
            }
        );


    for (
        const item of itens
    ) {

        const caminhoCompleto =
            path.join(
                pasta,
                item.name
            );


        if (
            item.isDirectory()
        ) {

            resultado.push(
                ...encontrarImagens(
                    caminhoCompleto
                )
            );

        } else {

            const extensao =
                path.extname(
                    item.name
                ).toLowerCase();


            if (
                extensoesImagem.includes(
                    extensao
                )
            ) {

                resultado.push({

                    caminho:
                        caminhoCompleto,

                    nome:
                        item.name

                });

            }

        }

    }


    return resultado;

}


/* =========================================================
   FUNÇÃO: MIME TYPE
========================================================= */

function obterMimeType(
    caminho
) {

    const extensao =
        path.extname(
            caminho
        ).toLowerCase();


    switch (
        extensao
    ) {

        case ".jpg":
        case ".jpeg":

            return "image/jpeg";


        case ".png":

            return "image/png";


        case ".webp":

            return "image/webp";


        default:

            return "application/octet-stream";

    }

}


/* =========================================================
   FUNÇÃO: REMOVER ARQUIVO
========================================================= */

function removerArquivo(
    caminho
) {

    try {

        if (
            caminho &&
            fs.existsSync(
                caminho
            )
        ) {

            fs.unlinkSync(
                caminho
            );

        }

    } catch (erro) {

        console.error(
            "Não foi possível remover arquivo temporário:",
            erro.message
        );

    }

}


/* =========================================================
   INICIA SERVIDOR
========================================================= */

app.listen(
    PORT,
    HOST,
    () => {

        console.log(
            `Servidor rodando em ${HOST}:${PORT}`
        );

    }
);
