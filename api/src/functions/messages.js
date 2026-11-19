const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const Busboy = require("busboy");
const crypto = require("crypto");
const { blobContainerClient, getReadSasUrl } = require("../blob");

const DEFAULT_CHANNEL = "general";

function getContainer() {
  const connStr = process.env.COSMOS_CONNECTION_STRING;
  if (!connStr) {
    throw new Error("Missing COSMOS_CONNECTION_STRING environment variable.");
  }
  const client = new CosmosClient(connStr);
  const database = client.database("CommunicationAppDb");
  return database.container("Messages");
}

function parseMultipart(req) {
  return new Promise(async (resolve, reject) => {
    try {
      const contentType = req.headers.get("content-type") || "";
      if (!contentType.includes("multipart/form-data")) {
        reject(new Error("Expected multipart/form-data request."));
        return;
      }

      const bb = Busboy({ headers: { "content-type": contentType } });
      const fields = {};
      let fileData = null;

      bb.on("field", (name, val) => {
        fields[name] = val;
      });

      bb.on("file", (name, file, info) => {
        const { filename, mimeType } = info;
        if (!filename) {
          file.resume();
          return;
        }
        const chunks = [];
        file.on("data", (chunk) => chunks.push(chunk));
        file.on("end", () => {
          fileData = {
            fieldName: name,
            fileName: filename,
            mimeType: mimeType || "application/octet-stream",
            buffer: Buffer.concat(chunks),
          };
        });
      });

      bb.on("error", reject);
      bb.on("finish", () => resolve({ fields, fileData }));

      const arrayBuffer = await req.arrayBuffer();
      bb.end(Buffer.from(arrayBuffer));
    } catch (err) {
      reject(err);
    }
  });
}

function attachSasUrl(doc) {
  return {
    ...doc,
    fileUrl: doc.blobName ? getReadSasUrl(doc.blobName) : null,
  };
}

// GET /api/messages?channelId=general
app.http("getMessages", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "messages",
  handler: async (req, context) => {
    try {
      const url = new URL(req.url);
      const channelId = (url.searchParams.get("channelId") || DEFAULT_CHANNEL).trim() || DEFAULT_CHANNEL;

      const container = getContainer();
      const querySpec = {
        query:
          "SELECT * FROM c WHERE (IS_DEFINED(c.channelId) ? c.channelId : 'general') = @channelId ORDER BY c.createdAt DESC",
        parameters: [{ name: "@channelId", value: channelId }],
      };

      const { resources } = await container.items.query(querySpec).fetchAll();
      const hydrated = resources.map(attachSasUrl);

      return {
        status: 200,
        jsonBody: {
          channelId,
          messages: hydrated,
        },
      };
    } catch (err) {
      context.error("GET /api/messages failed:", err);
      return {
        status: 500,
        jsonBody: { error: err.message || "Failed to load messages." },
      };
    }
  },
});

// POST /api/messages
app.http("createMessage", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "messages",
  handler: async (req, context) => {
    try {
      const { fields, fileData } = await parseMultipart(req);

      const userId = (fields.userId || "Anonymous").trim() || "Anonymous";
      const text = (fields.text || "").trim();
      const channelId = (fields.channelId || DEFAULT_CHANNEL).trim() || DEFAULT_CHANNEL;

      if (!text && !fileData) {
        return {
          status: 400,
          jsonBody: { error: "Please include a message or a file." },
        };
      }

      let blobName = null;
      let fileName = null;

      if (fileData && fileData.buffer.length > 0) {
        await blobContainerClient.createIfNotExists();
        const safeName = fileData.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
        blobName = `${Date.now()}-${safeName}`;
        fileName = fileData.fileName;

        const blockBlobClient = blobContainerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(fileData.buffer, {
          blobHTTPHeaders: { blobContentType: fileData.mimeType },
        });
      }

      const item = {
        id: crypto.randomUUID(),
        channelId,
        userId,
        text,
        blobName,
        fileName,
        createdAt: new Date().toISOString(),
      };

      const container = getContainer();
      const { resource: created } = await container.items.create(item);

      return {
        status: 201,
        jsonBody: attachSasUrl(created),
      };
    } catch (err) {
      context.error("POST /api/messages failed:", err);
      return {
        status: 500,
        jsonBody: { error: err.message || "Failed to create message." },
      };
    }
  },
});