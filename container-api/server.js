const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require("@azure/storage-blob");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Cosmos DB setup
const cosmosClient = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const db = cosmosClient.database("CommunicationAppDb");
const messagesContainer = db.container("Messages");
const eventsContainer = db.container("Events");

// Blob Storage + SAS setup
const blobConnStr = process.env.BLOB_CONNECTION_STRING;
const containerName = process.env.BLOB_CONTAINER_NAME || "uploads";
const accountName = blobConnStr.match(/AccountName=([^;]+)/)[1];
const accountKey = blobConnStr.match(/AccountKey=([^;]+)/)[1];
const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
const blobServiceClient = BlobServiceClient.fromConnectionString(blobConnStr);
const blobContainerClient = blobServiceClient.getContainerClient(containerName);

function getReadSasUrl(blobName) {
  if (!blobName) return null;
  const expiresOn = new Date(Date.now() + 60 * 60 * 1000);
  const sasToken = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"),
      expiresOn,
    },
    sharedKeyCredential
  ).toString();
  return `${blobContainerClient.getBlockBlobClient(blobName).url}?${sasToken}`;
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "azure-container-apps" });
});

app.post("/api/auth/login", (req, res) => {
  const name = (req.body?.userId || "").trim();
  const role = (req.body?.role || "Member").trim();
  if (!name) {
    return res.status(400).json({ error: "Username or display name is required." });
  }
  const token = crypto.randomBytes(16).toString("hex");
  return res.status(200).json({
    token,
    userId: name,
    role,
    loggedInAt: new Date().toISOString(),
  });
});

app.get("/api/messages", async (req, res) => {
  try {
    const channelId = (req.query.channelId || "general").trim() || "general";
    const querySpec = {
      query:
        "SELECT * FROM c WHERE (IS_DEFINED(c.channelId) ? c.channelId : 'general') = @channelId ORDER BY c.createdAt DESC",
      parameters: [{ name: "@channelId", value: channelId }],
    };
    const { resources } = await messagesContainer.items.query(querySpec).fetchAll();
    const messages = resources.map((doc) => ({
      ...doc,
      fileUrl: doc.blobName ? getReadSasUrl(doc.blobName) : null,
    }));
    res.json({ channelId, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/messages", upload.single("file"), async (req, res) => {
  try {
    const userId = (req.body.userId || "Anonymous").trim() || "Anonymous";
    const text = (req.body.text || "").trim();
    const channelId = (req.body.channelId || "general").trim() || "general";

    if (!text && !req.file) {
      return res.status(400).json({ error: "Please include a message or a file." });
    }

    let blobName = null;
    let fileName = null;

    if (req.file && req.file.buffer.length > 0) {
      await blobContainerClient.createIfNotExists();
      const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      blobName = `${Date.now()}-${safeName}`;
      fileName = req.file.originalname;

      const blockBlobClient = blobContainerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadData(req.file.buffer, {
        blobHTTPHeaders: { blobContentType: req.file.mimetype || "application/octet-stream" },
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

    const { resource: created } = await messagesContainer.items.create(item);
    res.status(201).json({
      ...created,
      fileUrl: created.blobName ? getReadSasUrl(created.blobName) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/events", async (req, res) => {
  try {
    const { resources } = await eventsContainer.items
      .query("SELECT * FROM c ORDER BY c.date ASC, c.time ASC")
      .fetchAll();
    res.json({ events: resources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/events", async (req, res) => {
  try {
    const title = (req.body.title || "").trim();
    const date = (req.body.date || "").trim();
    const time = (req.body.time || "").trim();
    const createdBy = (req.body.createdBy || "Anonymous").trim();

    if (!title || !date) {
      return res.status(400).json({ error: "Event title and date are required." });
    }

    const eventItem = {
      id: crypto.randomUUID(),
      title,
      date,
      time,
      createdBy,
      createdAt: new Date().toISOString(),
    };

    const { resource: created } = await eventsContainer.items.create(eventItem);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Container API listening on port ${PORT}`);
});