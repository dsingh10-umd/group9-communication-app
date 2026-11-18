const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions
} = require("@azure/storage-blob");

const connStr = process.env.BLOB_CONNECTION_STRING;
const containerName = process.env.BLOB_CONTAINER_NAME || "uploads";

const accountName = connStr.match(/AccountName=([^;]+)/)[1];
const accountKey = connStr.match(/AccountKey=([^;]+)/)[1];
const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);

const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
const blobContainerClient = blobServiceClient.getContainerClient(containerName);

function getReadSasUrl(blobName) {
  if (!blobName) return null;
  const expiresOn = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  const sasToken = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"),
      expiresOn
    },
    sharedKeyCredential
  ).toString();

  return `${blobContainerClient.getBlockBlobClient(blobName).url}?${sasToken}`;
}

module.exports = { blobContainerClient, getReadSasUrl };