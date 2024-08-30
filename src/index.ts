import express, { Request, Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { v4 as uuidv4 } from 'uuid';
import mongoose, { Document, Schema } from "mongoose";
import validator from 'validator';

dotenv.config();

const app = express();
const port = process.env.DKR_PORT || 3000;

const apiKey = process.env.DKR_GEMINI_API_KEY;
if (!apiKey) {
    throw new Error(`Status de GEMINI_API_KEY: ${apiKey}`);
}

const genAI = new GoogleGenerativeAI(apiKey);

// CADA ENDPOINT DEVE TER SEU ARQUIVO [EM DESENVOLVIMENTO]
// --- ENDPOINT: POST /upload ---

interface IReading extends Document {
    customer_code: string;
    measure_datetime: Date;
    measure_type: string;
    measure_value?: number;
    measure_uuid: string;
    image_url: string;
    confirmed_value?: number;
}

const readingSchema = new Schema<IReading>({
    customer_code: { type: String, required: true },
    measure_datetime: { type: Date, required: true },
    measure_type: { type: String, required: true },
    measure_value: { type: Number, required: false },
    measure_uuid: { type: String, required: true },
    image_url: { type: String, required: true },
    confirmed_value: { type: Number, required: false },
}, { timestamps: true });

const Reading = mongoose.model<IReading>("Reading", readingSchema);

app.use(express.json());

function validateBase64WithPrefix(base64String: string): { valid: boolean; message?: string; base64Data?: string; prefix?: string } {
    const prefixPattern = /^data:image\/(jpeg|png);base64,/;
    const matches = base64String.match(prefixPattern);

    if (!matches) {
        return { valid: false, message: "O campo 'image' deve incluir um prefixo de tipo de imagem válido e ser uma string base64 válida." };
    }

    const base64Data = base64String.replace(prefixPattern, "");

    if (!validator.isBase64(base64Data)) {
        return { valid: false, message: "O campo 'image' deve ser uma string base64 válida." };
    }

    return { valid: true, base64Data, prefix: matches[0] };
}

async function isDuplicateReading(customer_code: string, measure_type: string, measure_datetime: string): Promise<boolean> {
    const startOfMonth = new Date(measure_datetime);
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const endOfMonth = new Date(startOfMonth);
    endOfMonth.setMonth(startOfMonth.getMonth() + 1);

    const reading = await Reading.findOne({
        customer_code,
        measure_type,
        measure_datetime: {
            $gte: startOfMonth,
            $lt: endOfMonth,
        }
    });
    return reading !== null;
}

function validateRequestBody(body: any): { valid: boolean; message?: string; base64Data?: string; prefix?: string } {
    const { image, customer_code, measure_datetime, measure_type } = body;

    if (!image || !customer_code || !measure_datetime || !measure_type) {
        return { valid: false, message: "Todos os campos são obrigatórios." };
    }

    const base64Validation = validateBase64WithPrefix(image);
    if (!base64Validation.valid) {
        return { valid: false, message: base64Validation.message };
    }

    if (typeof customer_code !== 'string') {
        return { valid: false, message: "O campo 'customer_code' deve ser uma string." };
    }

    if (!validator.isISO8601(measure_datetime)) {
        return { valid: false, message: "O campo 'measure_datetime' deve ser uma data válida em formato ISO8601." };
    }

    if (!['WATER', 'GAS'].includes(measure_type)) {
        return { valid: false, message: "O campo 'measure_type' deve ser 'WATER' ou 'GAS'." };
    }

    return { valid: true, base64Data: base64Validation.base64Data, prefix: base64Validation.prefix };
}

app.post("/upload", async (req: Request, res: Response) => {
    const { image, customer_code, measure_datetime, measure_type } = req.body;

    const validation = validateRequestBody(req.body);
    if (!validation.valid) {
        return res.status(400).json({
            error_code: "INVALID_DATA",
            error_description: validation.message
        });
    }

    const { base64Data, prefix } = validation;

    if (await isDuplicateReading(customer_code, measure_type, measure_datetime)) {
        return res.status(409).json({
            error_code: "DOUBLE_REPORT",
            error_description: "Leitura do mês já realizada"
        });
    }

    try {
        const completeBase64 = `${prefix}${base64Data}`;

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt =
            `Return the value that is in the water or gas register, in this pattern:
        {
            "value": "VALUE",
        }`;

        if (!base64Data) {
            return res.status(400).json({
                error_code: "INVALID_DATA",
                error_description: "A imagem em base64 não é válida ou não foi fornecida."
            });
        }

        const imageParts = [{
            inlineData: {
                data: base64Data,
                mimeType: "image/jpeg",
            }
        }];

        const result = await model.generateContent([prompt, ...imageParts]);
        const response = await result.response;
        const text = await response.text();

        const match = text.match(/\d+/);
        const extractedValue = match ? parseInt(match[0], 10) : null;

        if (extractedValue === null) {
            return res.status(400).json({
                error_code: "MEASURE_NOT_FOUND",
                error_description: "Não foi possível extrair um valor numérico do texto retornado."
            });
        }

        const measureUuid = uuidv4();
        const imageUrl = "url_image";

        const newReading = new Reading({
            customer_code,
            measure_datetime,
            measure_type,
            measure_value: extractedValue,
            measure_uuid: measureUuid,
            image_url: imageUrl
        });

        await newReading.save();

        res.status(200).json({
            image_url: imageUrl,
            measure_value: extractedValue,
            measure_uuid: measureUuid,
        });
    } catch (error) {
        console.error("Erro ao processar imagem:", error);
        res.status(500).json({ error: "Erro ao processar imagem." });
    }
});

// --- ENDPOINT: PATCH /confirm ---

app.patch("/confirm", async (req: Request, res: Response) => {
    const { measure_uuid, confirmed_value } = req.body;

    if (!measure_uuid || typeof measure_uuid !== "string") {
        return res.status(400).json({
            error_code: "INVALID_DATA",
            error_description: "O campo 'measure_uuid' é obrigatório e deve ser uma string."
        });
    }

    if (typeof confirmed_value !== "number") {
        return res.status(400).json({
            error_code: "INVALID_DATA",
            error_description: "O campo 'confirmed_value' é obrigatório e deve ser um número."
        });
    }

    try {
        const reading = await Reading.findOne({ measure_uuid });

        if (!reading) {
            return res.status(404).json({
                error_code: "MEASURE_NOT_FOUND",
                error_description: "Leitura não encontrada."
            });
        }

        if (reading.confirmed_value) {
            return res.status(409).json({
                error_code: "CONFIRMATION_DUPLICATE",
                error_description: "Leitura já foi confirmada."
            });
        }

        reading.confirmed_value = confirmed_value;
        await reading.save();

        return res.status(200).json({
            success: true
        });
    } catch (error) {
        console.error("Erro ao confirmar leitura:", error);
        return res.status(500).json({
            error_code: "SERVER_ERROR",
            error_description: "Erro interno do servidor."
        });
    }
});

// --- ENDPOINT: GET /<customer_code>/list?measure_type=<measure_type> ---

app.get("/:customer_code/list", async (req: Request, res: Response) => {
    const { customer_code } = req.params;
    const { measure_type } = req.query;

    if (measure_type && typeof measure_type === 'string') {
        const validMeasureTypes = ["WATER", "GAS"];
        if (!validMeasureTypes.includes(measure_type.toUpperCase())) {
            return res.status(400).json({
                error_code: "INVALID_TYPE",
                error_description: "Tipo de medição não permitida"
            });
        }
    }

    try {
        const query: { customer_code: string; measure_type?: string } = { customer_code };
        if (measure_type && typeof measure_type === 'string') {
            query.measure_type = measure_type.toUpperCase();
        }

        const measures = await Reading.find(query).select(
            "measure_uuid measure_datetime measure_type image_url confirmed_value"
        );

        if (measures.length === 0) {
            return res.status(404).json({
                error_code: "MEASURES_NOT_FOUND",
                error_description: "Nenhuma leitura encontrada"
            });
        }

        const responseMeasures = measures.map(measure => ({
            measure_uuid: measure.measure_uuid,
            measure_datetime: measure.measure_datetime,
            measure_type: measure.measure_type,
            has_confirmed: measure.confirmed_value != null,
            image_url: measure.image_url,
        }));

        return res.status(200).json({
            customer_code,
            measures: responseMeasures
        });

    } catch (error) {
        console.error("Erro ao listar medidas:", error);
        return res.status(500).json({
            error_code: "SERVER_ERROR",
            error_description: "Erro interno do servidor."
        });
    }
});

// --- CONEXÃO SERVIDOR E DB ---

mongoose.connect(process.env.DKR_MONGODB_URI as string)
    .then(() => {
        console.log("Conectado ao banco de dados MongoDB.");
        app.listen(port, () => {
            console.log(`Servidor rodando na porta ${port}`);
        });
    })
    .catch(err => {
        console.error("Erro ao conectar ao banco de dados MongoDB:", err);
    });
