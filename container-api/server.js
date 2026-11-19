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
const channelsContainer = db.container("Channels");
const usersContainer = db.container("Users");
const workspacesContainer = db.container("Workspaces");

// The original team workspace. members: null means everyone can see it.
const DEFAULT_WORKSPACE = { id: "group9", name: "Group 9", members: null };
const DEFAULT_CHANNELS = [
  { id: "general", name: "general", topic: "Team-wide chat for Group 9" },
  { id: "announcements", name: "announcements", topic: "Deadlines, submissions and big updates" },
  { id: "dev-ops", name: "dev-ops", topic: "Azure, pipelines and deploys" },
];

const userKey = (name) => String(name || "").trim().toLowerCase();
const slugify = (name) => String(name || "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
// Channels made before workspaces existed belong to Group 9.
const workspaceOf = (channel) => channel.workspaceId || DEFAULT_WORKSPACE.id;
const cleanMembers = (list) =>
  [...new Map((list || []).map((m) => String(m).trim()).filter(Boolean).map((m) => [userKey(m), m])).values()];

async function deleteChannelAndMessages(id) {
  await channelsContainer.item(id, id).delete().catch(() => {});
  const { resources: msgs } = await messagesContainer.items
    .query({ query: "SELECT c.id, c.blobName FROM c WHERE c.channelId = @id", parameters: [{ name: "@id", value: id }] })
    .fetchAll();
  await Promise.all(
    msgs.map(async (m) => {
      await messagesContainer.item(m.id, m.id).delete().catch(() => {});
      if (m.blobName) await blobContainerClient.deleteBlob(m.blobName).catch(() => {});
    })
  );
}

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
  const loggedInAt = new Date().toISOString();
  // Remember who has signed in so they show up in the "new DM" member list.
  // A failed write shouldn't block login.
  usersContainer.items
    .upsert({ id: userKey(name), userId: name, role, lastSeen: loggedInAt })
    .catch((err) => console.warn("User upsert failed:", err.message));
  return res.status(200).json({ token, userId: name, role, loggedInAt });
});

app.get("/api/users", async (req, res) => {
  try {
    const { resources } = await usersContainer.items
      .query("SELECT c.userId, c.role FROM c")
      .fetchAll();
    res.json({ users: resources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Workspaces ----------
// Workspace doc: { id, name, members (null = everyone), createdBy, createdAt }
// Each workspace has its own channels. DMs live outside workspaces.
const canSee = (ws, me) => !ws.members || ws.members.map(userKey).includes(me);

app.get("/api/workspaces", async (req, res) => {
  try {
    const me = userKey(req.query.userId);
    let { resources } = await workspacesContainer.items.query("SELECT * FROM c").fetchAll();
    if (!resources.some((w) => w.id === DEFAULT_WORKSPACE.id)) {
      const { resource } = await workspacesContainer.items.upsert({
        ...DEFAULT_WORKSPACE, createdBy: "system", createdAt: new Date().toISOString(),
      });
      resources = [resource, ...resources];
    }
    res.json({ workspaces: resources.filter((w) => canSee(w, me)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/workspaces", async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const createdBy = (req.body.createdBy || "Anonymous").trim();
    if (!name) return res.status(400).json({ error: "Workspace name is required." });
    const now = new Date().toISOString();
    const workspace = {
      id: `${slugify(name) || "workspace"}-${crypto.randomBytes(3).toString("hex")}`,
      name,
      members: req.body.members === null ? null : cleanMembers([createdBy, ...(req.body.members || [])]),
      createdBy,
      createdAt: now,
    };
    const { resource } = await workspacesContainer.items.create(workspace);
    // Every new workspace starts with a #general channel.
    await channelsContainer.items.create({
      id: `general-${crypto.randomBytes(3).toString("hex")}`,
      kind: "channel",
      workspaceId: resource.id,
      name: "general",
      topic: `General chat for ${name}`,
      createdBy,
      createdAt: now,
    });
    res.status(201).json(resource);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/workspaces/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { resource: existing } = await workspacesContainer.item(id, id).read();
    if (!existing) return res.status(404).json({ error: "Workspace not found." });
    const updated = { ...existing };
    if (typeof req.body.name === "string") {
      updated.name = req.body.name.trim();
      if (!updated.name) return res.status(400).json({ error: "Workspace name is required." });
    }
    if (req.body.members === null) updated.members = null;
    else if (Array.isArray(req.body.members)) updated.members = cleanMembers(req.body.members);
    const { resource } = await workspacesContainer.item(id, id).replace(updated);
    res.json(resource);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/workspaces/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (id === DEFAULT_WORKSPACE.id) return res.status(400).json({ error: "The Group 9 workspace can't be deleted." });
    await workspacesContainer.item(id, id).delete();
    const { resources } = await channelsContainer.items
      .query({ query: "SELECT c.id FROM c WHERE c.workspaceId = @id", parameters: [{ name: "@id", value: id }] })
      .fetchAll();
    await Promise.all(resources.map((c) => deleteChannelAndMessages(c.id)));
    res.status(204).end();
  } catch (err) {
    if (err.code === 404) return res.status(404).json({ error: "Workspace not found." });
    res.status(500).json({ error: err.message });
  }
});

// ---------- Channels and DMs ----------
// Channel doc: { id, kind: "channel" | "dm", workspaceId (channels), name, topic, members (dm only), createdBy, createdAt }
app.get("/api/channels", async (req, res) => {
  try {
    const me = userKey(req.query.userId);
    let { resources } = await channelsContainer.items.query("SELECT * FROM c").fetchAll();

    // First run: seed the starter channels so Group 9 isn't empty.
    if (!resources.some((c) => c.kind !== "dm" && workspaceOf(c) === DEFAULT_WORKSPACE.id)) {
      const now = new Date().toISOString();
      const seeded = await Promise.all(
        DEFAULT_CHANNELS.map((c) =>
          channelsContainer.items
            .upsert({ ...c, kind: "channel", workspaceId: DEFAULT_WORKSPACE.id, createdBy: "system", createdAt: now })
            .then((r) => r.resource)
        )
      );
      resources = resources.concat(seeded);
    }

    // Only list channels from workspaces you can see, and DMs you're in.
    const { resources: workspaces } = await workspacesContainer.items.query("SELECT * FROM c").fetchAll();
    const hidden = new Set(workspaces.filter((w) => !canSee(w, me)).map((w) => w.id));
    const visible = resources.filter((c) =>
      c.kind === "dm"
        ? me && (c.members || []).map(userKey).includes(me)
        : !hidden.has(workspaceOf(c))
    );
    res.json({ channels: visible });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/channels", async (req, res) => {
  try {
    const kind = req.body.kind === "dm" ? "dm" : "channel";
    const createdBy = (req.body.createdBy || "Anonymous").trim();
    const now = new Date().toISOString();

    if (kind === "dm") {
      const members = cleanMembers([createdBy, ...(req.body.members || [])]);
      // Same people = same DM, so opening a DM twice doesn't make duplicates.
      const id = "dm-" + members.map(userKey).sort().join("--").replace(/[^a-z0-9-]/g, "_");
      const existing = await channelsContainer.item(id, id).read().then((r) => r.resource).catch(() => null);
      if (existing) return res.status(200).json(existing);
      const name = (req.body.name || "").trim();
      const { resource } = await channelsContainer.items.create({ id, kind, name, members, createdBy, createdAt: now });
      return res.status(201).json(resource);
    }

    const name = slugify(req.body.name);
    if (!name) return res.status(400).json({ error: "Channel name is required." });
    const item = {
      id: `${name}-${crypto.randomBytes(3).toString("hex")}`,
      kind,
      workspaceId: (req.body.workspaceId || DEFAULT_WORKSPACE.id).trim(),
      name,
      topic: (req.body.topic || "").trim(),
      createdBy,
      createdAt: now,
    };
    const { resource } = await channelsContainer.items.create(item);
    res.status(201).json(resource);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/channels/:id", async (req, res) => {
  try {
    const { resource: existing } = await channelsContainer.item(req.params.id, req.params.id).read();
    if (!existing) return res.status(404).json({ error: "Channel not found." });

    const updated = { ...existing };
    if (typeof req.body.name === "string") {
      updated.name = existing.kind === "dm" ? req.body.name.trim() : slugify(req.body.name);
      if (existing.kind !== "dm" && !updated.name) {
        return res.status(400).json({ error: "Channel name is required." });
      }
    }
    if (typeof req.body.topic === "string") updated.topic = req.body.topic.trim();

    const { resource } = await channelsContainer.item(existing.id, existing.id).replace(updated);
    res.json(resource);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/channels/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (id === "general") return res.status(400).json({ error: "#general can't be deleted." });
    const { resource: existing } = await channelsContainer.item(id, id).read();
    if (!existing) return res.status(404).json({ error: "Channel not found." });
    await deleteChannelAndMessages(id);
    res.status(204).end();
  } catch (err) {
    if (err.code === 404) return res.status(404).json({ error: "Channel not found." });
    res.status(500).json({ error: err.message });
  }
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
      fileType: req.file ? req.file.mimetype || null : null,
      fileSize: req.file ? req.file.size : null,
      // Set when this message announces a meeting, so the chat can show a meeting card
      eventId: (req.body.eventId || "").trim() || null,
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
    const str = (v) => (typeof v === "string" ? v.trim() : "");
    const title = str(req.body.title);
    const date = str(req.body.date);
    // startTime replaces the old "time" field; older clients still send "time"
    const startTime = str(req.body.startTime) || str(req.body.time);
    const createdBy = str(req.body.createdBy) || "Anonymous";

    if (!title || !date) {
      return res.status(400).json({ error: "Event title and date are required." });
    }

    const eventItem = {
      id: crypto.randomUUID(),
      title,
      date,
      startTime,
      endTime: str(req.body.endTime),
      time: startTime,
      description: str(req.body.description),
      channelId: str(req.body.channelId) || null,
      workspaceId: str(req.body.workspaceId) || null,
      createdBy,
      createdAt: new Date().toISOString(),
    };

    const { resource: created } = await eventsContainer.items.create(eventItem);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/events/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { resource: existing } = await eventsContainer.item(id, id).read();
    if (!existing) return res.status(404).json({ error: "Event not found." });

    const updated = { ...existing, updatedAt: new Date().toISOString() };
    for (const field of ["title", "date", "startTime", "endTime", "description"]) {
      if (typeof req.body[field] === "string") updated[field] = req.body[field].trim();
    }
    for (const field of ["channelId", "workspaceId"]) {
      if (typeof req.body[field] === "string") updated[field] = req.body[field].trim() || null;
    }
    updated.time = updated.startTime || "";
    if (!updated.title || !updated.date) {
      return res.status(400).json({ error: "Event title and date are required." });
    }

    const { resource } = await eventsContainer.item(id, id).replace(updated);
    res.json(resource);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/events/:id", async (req, res) => {
  try {
    await eventsContainer.item(req.params.id, req.params.id).delete();
    res.status(204).end();
  } catch (err) {
    if (err.code === 404) return res.status(404).json({ error: "Event not found." });
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Container API listening on port ${PORT}`);
});