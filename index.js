import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { v4 as uuidv4 } from 'uuid';
import mongoose from "mongoose";
import validator from 'validator';

dotenv.config();

const app = express();
const port = process.env.DKR_PORT || 3000;
const genAI = new GoogleGenerativeAI(process.env.DKR_GEMINI_API_KEY);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.DKR_MONGODB_URI, {});
    console.log("Conectado ao MongoDB");
  } catch (error) {
    console.error('Erro ao conectar ao MongoDB:', error.message);
  }
};

connectDB();

const readingSchema = new mongoose.Schema({
  customer_code: String,
  measure_datetime: Date,
  measure_type: String,
  measure_value: Number,
  measure_uuid: String,
  image_url: String,
}, { timestamps: true });

const Reading = mongoose.model("Reading", readingSchema);

app.use(express.json());

function validateBase64WithPrefix(base64String) {
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

async function isDuplicateReading(customer_code, measure_type, measure_datetime) {
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

function validateRequestBody(body) {
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

app.post("/upload", async (req, res) => {
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

    const imageParts = [{
      inlineData: {
        data: base64Data,
        mimeType: "image/jpeg",
      }
    }];

    const result = await model.generateContent([prompt, ...imageParts]);
    const response = await result.response;
    const text = await response.text();

    const extractedValue = parseInt(text.match(/\d+/)[0]);
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

app.listen(port, () => {
  console.log(`API rodando na porta ${port}`);
});
