const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const crypto = require("crypto");
const { blobContainerClient, getReadSasUrl } = require("../blob");

const DATABASE_NAME = "CommunicationAppDb";
const CONTAINER_NAME = "Messages";

let messagesContainerPromise = null;

async function connectMessagesContainer() {
  const connectionString = process.env.CosmosDBConnection;
  if (!connectionString) {
    throw new Error("CosmosDBConnection app setting is not set.");
  }

  const client = new CosmosClient(connectionString);
  const { database } = await client.databases.createIfNotExists({ id: DATABASE_NAME });
  const { container } = await database.containers.createIfNotExists({
    id: CONTAINER_NAME,
    partitionKey: { paths: ["/id"] },
  });
  return container;
}

function getMessagesContainer() {
  if (!messagesContainerPromise) {
    messagesContainerPromise = connectMessagesContainer().catch((error) => {
      messagesContainerPromise = null;
      throw error;
    });
  }
  return messagesContainerPromise;
}

// POST /api/messages -> Upload optional file to Blob + save post to Cosmos DB
app.http("createMessage", {
  methods: ["POST"],
  route: "messages",
  authLevel: "anonymous",
  handler: async (request, context) => {
    try {
      const cosmosContainer = await getMessagesContainer();
      const formData = await request.formData();
      const text = formData.get("text") || "";
      const userId = formData.get("userId") || "anonymous";
      const file = formData.get("file");

      let blobName = null;
      let fileName = null;

      if (file && typeof file.arrayBuffer === "function") {
        const buffer = Buffer.from(await file.arrayBuffer());
        fileName = file.name;
        blobName = `${Date.now()}-${file.name}`;

        const blockBlobClient = blobContainerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(buffer, {
          blobHTTPHeaders: { blobContentType: file.type }
        });
      }

      const item = {
        id: crypto.randomUUID(),
        userId,
        text,
        blobName,
        fileName,
        createdAt: new Date().toISOString()
      };

      await cosmosContainer.items.create(item);

      return {
        status: 201,
        jsonBody: {
          ...item,
          attachmentUrl: getReadSasUrl(blobName)
        }
      };
    } catch (error) {
      context.error("Error creating message:", error);
      return { status: 500, jsonBody: { error: error.message } };
    }
  }
});

// GET /api/messages -> Fetch posts from Cosmos DB + attach viewable SAS URLs
app.http("getMessages", {
  methods: ["GET"],
  route: "messages",
  authLevel: "anonymous",
  handler: async (request, context) => {
    try {
      const cosmosContainer = await getMessagesContainer();
      const { resources } = await cosmosContainer.items
        .query("SELECT * FROM c ORDER BY c.createdAt DESC")
        .fetchAll();

      const enriched = resources.map((doc) => ({
        ...doc,
        attachmentUrl: getReadSasUrl(doc.blobName)
      }));

      return { status: 200, jsonBody: enriched };
    } catch (error) {
      context.error("Error fetching messages:", error);
      return { status: 500, jsonBody: { error: error.message } };
    }
  }
});