const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const { graphql } = require("@octokit/graphql");

const owner = process.env.REPO_OWNER;
const repo = process.env.REPO_NAME;
const token = process.env.GITHUB_TOKEN;
const contentDir = path.join(process.cwd(), "content");

const github = graphql.defaults({
  headers: { authorization: `token ${token}` },
});

function walk(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir).flatMap((name) => {
    const fullPath = path.join(dir, name);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      return name.toLowerCase() === "images" ? [] : walk(fullPath);
    }

    return name.endsWith(".md") ? [fullPath] : [];
  });
}

async function getRepository() {
  const { repository } = await github(`
    query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        id
        discussionCategories(first: 100) {
          nodes {
            id
            name
          }
        }
      }
    }
  `, { owner, repo });

  return repository;
}

async function createDiscussion(repositoryId, categoryId, title, body) {
  const { createDiscussion } = await github(`
    mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {
        repositoryId: $repositoryId,
        categoryId: $categoryId,
        title: $title,
        body: $body
      }) {
        discussion {
          id
          url
        }
      }
    }
  `, { repositoryId, categoryId, title, body });

  return createDiscussion.discussion;
}

async function updateDiscussion(discussionId, title, body) {
  const { updateDiscussion } = await github(`
    mutation($discussionId: ID!, $title: String!, $body: String!) {
      updateDiscussion(input: {
        discussionId: $discussionId,
        title: $title,
        body: $body
      }) {
        discussion {
          id
          url
        }
      }
    }
  `, { discussionId, title, body });

  return updateDiscussion.discussion;
}

function getInfo(file) {
  const parts = path.relative(contentDir, file).split(path.sep);

  return {
    section: parts[0],
    category: parts[1],
  };
}

function toRawUrl(file, imgPath) {
  if (/^(https?:|data:)/i.test(imgPath)) return imgPath;

  const dir = path.dirname(path.relative(process.cwd(), file)).replace(/\\/g, "/");
  const fullPath = `${dir}/${imgPath}`.replace(/\\/g, "/");

  return `https://raw.githubusercontent.com/${owner}/${repo}/main/${fullPath}`;
}

function convertImages(content, file) {
  return content
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
      return `![${alt}](${toRawUrl(file, src)})`;
    })
    .replace(/<img\s+src="([^"]+)"/g, (_, src) => {
      return `<img src="${toRawUrl(file, src)}"`;
    });
}

async function main() {
  const files = walk(contentDir);

  if (!files.length) {
    console.log("No markdown files found.");
    return;
  }

  const repository = await getRepository();
  const categoryMap = new Map(
    repository.discussionCategories.nodes.map((c) => [
      c.name.toLowerCase(),
      c.id,
    ])
  );

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = matter(raw);
    const inferred = getInfo(file);

    const title = parsed.data.title || path.basename(file, ".md");
    const section = parsed.data.section || inferred.section;
    const category = parsed.data.category || inferred.category;
    const categoryId = categoryMap.get(String(category).toLowerCase());

    if (!categoryId) {
      console.warn(`Skip: Discussion category "${category}" not found.`);
      continue;
    }

    const body = convertImages(parsed.content.trim(), file);

    if (parsed.data.discussion_id) {
      await updateDiscussion(parsed.data.discussion_id, title, body);
      console.log(`Updated: ${title}`);
      continue;
    }

    const discussion = await createDiscussion(
      repository.id,
      categoryId,
      title,
      body
    );

    Object.assign(parsed.data, {
      title,
      section,
      category,
      discussion_id: discussion.id,
      discussion_url: discussion.url,
    });

    fs.writeFileSync(file, matter.stringify(parsed.content, parsed.data), "utf8");
    console.log(`Created: ${title}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});