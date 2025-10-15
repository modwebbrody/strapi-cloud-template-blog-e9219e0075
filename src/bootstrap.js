"use strict";

const fs = require("fs-extra");
const path = require("path");
const mime = require("mime-types");

async function isFirstRun() {
  const pluginStore = strapi.store({
    environment: strapi.config.environment,
    type: "type",
    name: "setup",
  });
  const initHasRun = await pluginStore.get({ key: "initHasRun" });
  await pluginStore.set({ key: "initHasRun", value: true });
  return !initHasRun;
}

async function seedExampleApp() {
  const shouldImportSeedData = await isFirstRun();

  if (shouldImportSeedData) {
    try {
      console.log("Setting up the template...");

      // Import data file
      const {
        categories,
        authors,
        articles,
        global,
        about,
      } = require("../data/data.json");

      await importSeedData(categories, authors, articles, global, about);
      console.log("Ready to go");
    } catch (error) {
      console.log("Could not import seed data");
      console.error(error);
    }
  } else {
    console.log(
      "Seed data has already been imported. We cannot reimport unless you clear your database first.",
    );
  }
}

async function setPublicPermissions(newPermissions) {
  const publicRole = await strapi
    .query("plugin::users-permissions.role")
    .findOne({
      where: {
        type: "public",
      },
    });

  const allPermissionsToCreate = [];
  Object.keys(newPermissions).map((controller) => {
    const actions = newPermissions[controller];
    const permissionsToCreate = actions.map((action) => {
      return strapi.query("plugin::users-permissions.permission").create({
        data: {
          action: `api::${controller}.${controller}.${action}`,
          role: publicRole.id,
        },
      });
    });
    allPermissionsToCreate.push(...permissionsToCreate);
  });
  await Promise.all(allPermissionsToCreate);
}

function getFileSizeInBytes(filePath) {
  const stats = fs.statSync(filePath);
  const fileSizeInBytes = stats["size"];
  return fileSizeInBytes;
}

function getFileData(fileName) {
  const filePath = path.join("data", "uploads", fileName);

  // Check if file exists before trying to get stats
  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return null;
  }

  const size = getFileSizeInBytes(filePath);
  const ext = fileName.split(".").pop();
  const mimeType = mime.lookup(ext || "") || "";

  return {
    filepath: filePath,
    originalFileName: fileName,
    size,
    mimetype: mimeType,
  };
}

async function uploadFile(file, name) {
  if (!file) {
    console.log(`Skipping upload for ${name} - file data is null`);
    return [];
  }

  try {
    return await strapi
      .plugin("upload")
      .service("upload")
      .upload({
        files: file,
        data: {
          fileInfo: {
            alternativeText: `An image uploaded to Strapi called ${name}`,
            caption: name,
            name,
          },
        },
      });
  } catch (error) {
    console.error(`Error uploading file ${name}:`, error.message);
    return [];
  }
}

async function createEntry({ model, entry }) {
  try {
    await strapi.documents(`api::${model}.${model}`).create({
      data: entry,
    });
  } catch (error) {
    console.error({ model, entry, error: error.message });
  }
}

async function checkFileExistsBeforeUpload(files) {
  const existingFiles = [];
  const uploadedFiles = [];
  const filesCopy = [...files];

  for (const fileName of filesCopy) {
    const fileWhereName = await strapi.query("plugin::upload.file").findOne({
      where: {
        name: fileName.replace(/\..*$/, ""),
      },
    });

    if (fileWhereName) {
      existingFiles.push(fileWhereName);
    } else {
      const fileData = getFileData(fileName);

      if (!fileData) {
        console.log(`Skipping ${fileName} - file not found`);
        continue;
      }

      const fileNameNoExtension = fileName.split(".").shift();
      const [file] = await uploadFile(fileData, fileNameNoExtension);

      if (file) {
        uploadedFiles.push(file);
      }
    }
  }

  const allFiles = [...existingFiles, ...uploadedFiles];
  return allFiles.length === 1 ? allFiles[0] : allFiles;
}

async function updateBlocks(blocks) {
  const updatedBlocks = [];

  for (const block of blocks) {
    if (block.__component === "shared.media") {
      const uploadedFiles = await checkFileExistsBeforeUpload([block.file]);
      const blockCopy = { ...block };
      blockCopy.file = uploadedFiles;
      updatedBlocks.push(blockCopy);
    } else if (block.__component === "shared.slider") {
      const existingAndUploadedFiles = await checkFileExistsBeforeUpload(
        block.files,
      );
      const blockCopy = { ...block };
      blockCopy.files = existingAndUploadedFiles;
      updatedBlocks.push(blockCopy);
    } else {
      updatedBlocks.push(block);
    }
  }

  return updatedBlocks;
}

async function importArticles(articles) {
  for (const article of articles) {
    const cover = await checkFileExistsBeforeUpload([`${article.slug}.jpg`]);
    const updatedBlocks = await updateBlocks(article.blocks);

    await createEntry({
      model: "article",
      entry: {
        ...article,
        cover,
        blocks: updatedBlocks,
        publishedAt: Date.now(),
      },
    });
  }
}

async function importGlobal(global) {
  const favicon = await checkFileExistsBeforeUpload(["favicon.png"]);
  const shareImage = await checkFileExistsBeforeUpload(["default-image.png"]);

  return createEntry({
    model: "global",
    entry: {
      ...global,
      favicon,
      publishedAt: Date.now(),
      defaultSeo: {
        ...global.defaultSeo,
        shareImage,
      },
    },
  });
}

async function importAbout(about) {
  const updatedBlocks = await updateBlocks(about.blocks);

  await createEntry({
    model: "about",
    entry: {
      ...about,
      blocks: updatedBlocks,
      publishedAt: Date.now(),
    },
  });
}

async function importCategories(categories) {
  for (const category of categories) {
    await createEntry({ model: "category", entry: category });
  }
}

async function importAuthors(authors) {
  for (const author of authors) {
    const avatar = await checkFileExistsBeforeUpload([author.avatar]);

    await createEntry({
      model: "author",
      entry: {
        ...author,
        avatar,
      },
    });
  }
}

async function importSeedData(categories, authors, articles, global, about) {
  await setPublicPermissions({
    article: ["find", "findOne"],
    category: ["find", "findOne"],
    author: ["find", "findOne"],
    global: ["find", "findOne"],
    about: ["find", "findOne"],
  });

  await importCategories(categories);
  await importAuthors(authors);
  await importArticles(articles);
  await importGlobal(global);
  await importAbout(about);
}

module.exports = async () => {
  await seedExampleApp();
};
