const express = require("express");
const cors = require("cors");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

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
                "Erro durante o processamento:"
            );

            console.error(erro);

            return res.status(500).json({

                erro:
                    "Erro ao processar o arquivo.",

                detalhes:
                    erro.message

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
   FUNÇÃO: ENCONTRAR IMAGENS
========================================================= */

function encontrarImagens(pasta) {

    const resultado = [];

    const itens = fs.readdirSync(
        pasta,
        {
            withFileTypes: true
        }
    );

    for (const item of itens) {

        const caminhoCompleto =
            path.join(
                pasta,
                item.name
            );


        if (item.isDirectory()) {

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

function obterMimeType(caminho) {

    const extensao =
        path.extname(
            caminho
        ).toLowerCase();


    switch (extensao) {

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

function removerArquivo(caminho) {

    try {

        if (
            caminho &&
            fs.existsSync(caminho)
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
