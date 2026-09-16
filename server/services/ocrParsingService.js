import Anthropic from "@anthropic-ai/sdk";

// 第一批20轮ChatGPT复核确认的技术选型：用视觉LLM（原生支持PDF、零样本理解）替代传统OCR+规则，
// 应对"几十家供应商发票格式五花八门、没有统一模板"这个场景。sonnet级别够用，不需要opus的推理能力。
const MODEL = "claude-sonnet-5";

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export function isOcrConfigured() {
  return client !== null;
}

const INVOICE_TOOL = {
  name: "extract_invoice",
  description: "从这张发票图片/PDF里提取结构化字段",
  input_schema: {
    type: "object",
    properties: {
      is_invoice: { type: "boolean", description: "这份文档是不是一张发票/入库单据，不是的话（比如传错了文件）填false" },
      header: {
        type: "object",
        properties: {
          invoice_no: { type: ["string", "null"] },
          invoice_date: { type: ["string", "null"], description: "格式 YYYY-MM-DD" },
          due_date: { type: ["string", "null"], description: "格式 YYYY-MM-DD" },
          invoice_type: { type: ["string", "null"] },
          currency: { type: "string", description: "三位货币代码，没写明的话默认 AUD" },
          subtotal: { type: ["number", "null"] },
          gst: { type: ["number", "null"] },
          total_amount: { type: ["number", "null"] },
          confidence: { type: "number", description: "0~1之间，表头整体识别置信度" },
          source_quotes: {
            type: "object",
            description: "每个字段在原文里读到的原始文字片段，key跟上面字段名对应，方便人工核对定位",
            additionalProperties: { type: "string" }
          }
        },
        required: ["confidence"]
      },
      items: {
        type: "array",
        description: "发票/入库单明细行，逐行提取；如果确实没有明细（比如只有表头的简单单据），返回空数组",
        items: {
          type: "object",
          properties: {
            line_no: { type: ["integer", "null"] },
            supplier_item_name: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
            quantity: { type: ["number", "null"] },
            unit: { type: ["string", "null"] },
            unit_price: { type: ["number", "null"] },
            amount: { type: ["number", "null"] },
            gst_rate: { type: ["number", "null"], description: "小数形式，10% 存成 0.1000，不是 10" },
            delivery_docket_no: { type: ["string", "null"] },
            purchase_order_no: { type: ["string", "null"] },
            confidence: { type: "number" },
            source_quote: { type: ["string", "null"] }
          },
          required: ["confidence"]
        }
      },
      notes: { type: ["string", "null"], description: "任何值得人工注意的异常情况，没有就填null" }
    },
    required: ["is_invoice", "header", "items"]
  }
};

const CREDIT_TOOL = {
  name: "extract_credit",
  description: "从这张 Credit Note（供应商退款/折让单）图片/PDF里提取结构化字段",
  input_schema: {
    type: "object",
    properties: {
      // 字段名沿用 is_invoice（不是叫 is_credit_note）：跟 INVOICE_TOOL 共用同一段
      // callExtractionTool() 完整性校验逻辑，两边字段名对齐才能复用同一个if判断。
      is_invoice: { type: "boolean", description: "这份文档是不是一张Credit Note，不是的话填false" },
      header: {
        type: "object",
        properties: {
          credit_note_no: { type: ["string", "null"] },
          credit_date: { type: ["string", "null"], description: "格式 YYYY-MM-DD" },
          delivery_docket_no: { type: ["string", "null"] },
          reason: { type: ["string", "null"] },
          total_amount: { type: ["number", "null"] },
          confidence: { type: "number" },
          source_quotes: {
            type: "object",
            additionalProperties: { type: "string" }
          }
        },
        required: ["confidence"]
      },
      notes: { type: ["string", "null"] }
    },
    required: ["is_invoice", "header"]
  }
};

function contentBlockFor(mimeType, base64Data) {
  if (mimeType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: mimeType, data: base64Data } };
  }
  return { type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } };
}

async function callExtractionTool(buffer, mimeType, tool, promptText) {
  if (!client) {
    const error = new Error("ANTHROPIC_API_KEY 未配置，OCR解析功能不可用。");
    error.code = "OCR_NOT_CONFIGURED";
    throw error;
  }

  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 4096,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [
        {
          role: "user",
          content: [
            contentBlockFor(mimeType, buffer.toString("base64")),
            { type: "text", text: promptText }
          ]
        }
      ]
    },
    // 主动定义失败边界，不依赖SDK/网络层默认行为兜底——超时会抛SDK自己的
    // APIConnectionTimeoutError，走下面已有的catch(parseError)分支，不需要单独处理。
    { timeout: 120_000 }
  );

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse) {
    const error = new Error("模型没有按预期返回结构化结果（没有tool_use block）。");
    error.code = "OCR_NO_TOOL_USE";
    throw error;
  }

  // 实测发现：哪怕用 tool_choice 强制走工具调用，模型偶尔还是会返回一个字段缺失/空的input
  // （比如 is_invoice/header 整个不存在）——这跟"文档不是发票"是两回事，不能被当成后者悄悄放过，
  // 否则会在后面访问 parsed.header.xxx 时炸出一个跟真实原因不相关的500。当成调用失败处理，
  // 走跟网络超时/限流一样的"标记异常状态+人工重试"路径。
  // 实测中发现的第二种不完整响应：header对象存在，但confidence这个理应必填的字段缺失、
  // 整个表头基本是空的——模型"确信这是发票"但实际上没能真正读出内容（很可能是文档渲染失败），
  // 不能让这种情况悄悄写成一张"parsed但什么都没有"的发票。
  const input = toolUse.input;
  const headerLooksEmpty = input?.is_invoice && typeof input.header?.confidence !== "number";
  // CREDIT_TOOL没有items字段（Credit Note只有表头），从tool定义本身推导要不要校验items，
  // 不硬编码tool.name——避免credit场景被invoice专属的校验误伤，以后加新工具也不用改这段。
  const toolHasItems = "items" in tool.input_schema.properties;
  const itemsLooksInvalid = toolHasItems && input?.is_invoice && !Array.isArray(input.items);
  if (
    typeof input?.is_invoice !== "boolean" ||
    (input.is_invoice && typeof input.header !== "object") ||
    headerLooksEmpty ||
    itemsLooksInvalid
  ) {
    const error = new Error("模型返回的结构化结果缺少必要字段（is_invoice/header/confidence/items），可能是文档渲染失败，建议重试。");
    error.code = "OCR_INCOMPLETE_RESPONSE";
    throw error;
  }

  return input;
}

export async function parseInvoiceDocument(buffer, mimeType) {
  return callExtractionTool(
    buffer,
    mimeType,
    INVOICE_TOOL,
    "这是一张来自澳洲供应商的发票或入库单据，请提取表头信息和逐行明细。金额是AUD澳元。" +
      "gst_rate字段务必用小数形式（10%存成0.1000）。每个字段尽量附上你在原文里读到的原始文字摘抄。" +
      "如果这份文档根本不是发票/单据，把 is_invoice 设为 false 并在 notes 里说明原因。"
  );
}

export async function parseCreditDocument(buffer, mimeType) {
  return callExtractionTool(
    buffer,
    mimeType,
    CREDIT_TOOL,
    "这是一张来自澳洲供应商的 Credit Note（退款/折让单），请提取表头信息。金额是AUD澳元。" +
      "每个字段尽量附上你在原文里读到的原始文字摘抄。" +
      "如果这份文档根本不是Credit Note，把 is_invoice 设为 false 并在 notes 里说明原因。"
  );
}
