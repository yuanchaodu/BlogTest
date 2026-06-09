const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const { graphql } = require("@octokit/graphql");

const owner = process.env.REPO_OWNER;
const repo = process.env.REPO_NAME;
const token = process.env.GITHUB_TOKEN;

const contentDir = path.join(process.cwd(), "content");

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${token}`,
  },
});

function walk(dir) {
  let results = [];

  if (!fs.existsSync(dir)) return results;

  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (file.toLowerCase() !== "images") {
        results = results.concat(walk(fullPath));
      }
    } else if (file.endsWith(".md")) {
      results.push(fullPath);
    }
  }

  return results;
}

async function getRepositoryInfo() {
  const result = await graphqlWithAuth(`
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
  `, {
    owner,
    repo,
  });

  return result.repository;
}

async function createDiscussion(repositoryId, categoryId, title, body) {
  const result = await graphqlWithAuth(`
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
  `, {
    repositoryId,
    categoryId,
    title,
    body,
  });

  return result.createDiscussion.discussion;
}

async function updateDiscussion(discussionId, title, body) {
  const result = await graphqlWithAuth(`
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
  `, {
    discussionId,
    title,
    body,
  });

  return result.updateDiscussion.discussion;
}

function inferSectionAndCategory(filePath) {
  const relative = path.relative(contentDir, filePath);
  const parts = relative.split(path.sep);

  return {
    section: parts[0],
    category: parts[1],
  };
}

function convertImagePaths(content, filePath) {
  const relativeDir = path.dirname(
    path.relative(process.cwd(), filePath)
  ).replace(/\\/g, "/");

  // Markdown image
  content = content.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (match, alt, imgPath) => {
      const fullPath = `${relativeDir}/${imgPath}`.replace(/\\/g, "/");
      return `![${alt}](https://raw.githubusercontent.com/${owner}/${repo}/main/${fullPath})`;
    }
  );

  // HTML image
  content = content.replace(
    /<img\s+src="([^"]+)"/g,
    (match, imgPath) => {
      const fullPath = `${relativeDir}/${imgPath}`.replace(/\\/g, "/");
      return `<img src="https://raw.githubusercontent.com/${owner}/${repo}/main/${fullPath}"`;
    }
  );

  return content;
}

async function main() {
  const files = walk(contentDir);

  if (files.length === 0) {
    console.log("No markdown files found.");
    return;
  }

  const repoInfo = await getRepositoryInfo();
  const repositoryId = repoInfo.id;

  const categoryMap = new Map(
    repoInfo.discussionCategories.nodes.map((item) => [
      item.name.toLowerCase(),
      item.id,
    ])
  );

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = matter(raw);

    const inferred = inferSectionAndCategory(file);

    const title =
      parsed.data.title ||
      path.basename(file, ".md");

    const section =
      parsed.data.section ||
      inferred.section;

    const category =
      parsed.data.category ||
      inferred.category;

    if (!category) {
      console.warn(`Skip: category not found in ${file}`);
      continue;
    }

    const categoryId = categoryMap.get(String(category).toLowerCase());

    if (!categoryId) {
      console.warn(`Skip: Discussion category "${category}" not found.`);
      continue;
    }

    const body = convertImagePaths(parsed.content.trim(), file);

    let discussion;

    if (parsed.data.discussion_id) {
      discussion = await updateDiscussion(
        parsed.data.discussion_id,
        title,
        body
      );

      console.log(`Updated: ${title}`);
    } else {
      discussion = await createDiscussion(
        repositoryId,
        categoryId,
        title,
        body
      );

      parsed.data.discussion_id = discussion.id;
      parsed.data.discussion_url = discussion.url;
      parsed.data.section = section;
      parsed.data.category = category;
      parsed.data.title = title;

      const newContent = matter.stringify(parsed.content, parsed.data);
      fs.writeFileSync(file, newContent, "utf8");

      console.log(`Created: ${title}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});