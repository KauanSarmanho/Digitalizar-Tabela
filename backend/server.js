const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
    dest: "uploads/"
});

app.use(express.json());

app.post("/processar", upload.single("arquivo"), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                erro: "Nenhum arquivo foi enviado."
            });
        }

        const caminhoZip = req.file.path;

        const zip = new AdmZip(caminhoZip);
        const arquivos = zip.getEntries();

        const fotos = arquivos.filter(arquivo => {
            if (arquivo.isDirectory) {
                return false;
            }

            const extensao = path.extname(arquivo.entryName).toLowerCase();

            return [".jpg", ".jpeg", ".png", ".webp"].includes(extensao);
        });

        fs.unlinkSync(caminhoZip);

        res.json({
            mensagem: "Arquivo recebido com sucesso.",
            quantidadeFotos: fotos.length,
            fotos: fotos.map(foto => foto.entryName)
        });

    } catch (erro) {
        console.error(erro);

        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({
            erro: "Erro ao processar o arquivo."
        });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
