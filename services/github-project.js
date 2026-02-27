const { graphql } = require('@octokit/graphql');

// GraphQL client with auth
const graphqlWithAuth = graphql.defaults({
  headers: { authorization: `token ${process.env.GITHUB_TOKEN}` }
});

// Cache for project metadata (prevents repeated lookups)
let projectCache = null;

/**
 * Get project ID and field IDs from cache or API
 * Supports both organization and personal/user projects
 */
async function getProjectMeta() {
  if (projectCache) return projectCache;

  const config = require('../config/users.json');
  const owner = process.env.GITHUB_OWNER;
  const projectNumber = config.projectConfig.projectNumber;

  if (!projectNumber) {
    throw new Error('Project number not configured. Complete onboarding first.');
  }

  // Try organization first, then user
  const queries = [
    {
      type: 'organization',
      query: `
        query($owner: String!, $projectNumber: Int!) {
          organization(login: $owner) {
            projectV2(number: $projectNumber) {
              id
              fields(first: 20) {
                nodes {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    options { id name }
                  }
                }
              }
            }
          }
        }
      `
    },
    {
      type: 'user',
      query: `
        query($owner: String!, $projectNumber: Int!) {
          user(login: $owner) {
            projectV2(number: $projectNumber) {
              id
              fields(first: 20) {
                nodes {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    options { id name }
                  }
                }
              }
            }
          }
        }
      `
    }
  ];

  for (const { type, query } of queries) {
    try {
      const result = await graphqlWithAuth(query, { owner, projectNumber });
      
      const project = result[type]?.projectV2;
      if (!project) continue;

      // Extract field IDs
      const fields = {};
      for (const field of project.fields.nodes) {
        if (field && field.name) {
          fields[field.name] = {
            id: field.id,
            options: field.options || []
          };
        }
      }

      projectCache = {
        projectId: project.id,
        fields,
        ownerType: type
      };

      console.log(`✅ Found GitHub Project as ${type}`);
      return projectCache;
    } catch (error) {
      // Try next query type
      continue;
    }
  }

  throw new Error(`Project #${projectNumber} not found for owner ${owner} (tried org and user)`);
}

/**
 * Get GitHub username from Discord username via mapping
 */
function mapAssignee(discordUsername) {
  if (!discordUsername) return null;
  
  const config = require('../config/users.json');
  const normalized = discordUsername.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  for (const [discord, github] of Object.entries(config.discordToGithub)) {
    if (discord.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized) {
      return github;
    }
  }
  
  return null;
}

/**
 * Get priority option ID from field
 */
function getPriorityOptionId(fields, priority) {
  const priorityField = fields['Priority'];
  if (!priorityField) return null;
  
  const option = priorityField.options.find(
    opt => opt.name.toLowerCase() === priority.toLowerCase()
  );
  
  return option?.id || null;
}

/**
 * Get status option ID from field
 */
function getStatusOptionId(fields, statusName) {
  const statusField = fields['Status'];
  if (!statusField) return null;
  
  const option = statusField.options.find(
    opt => opt.name.toLowerCase() === statusName.toLowerCase()
  );
  
  return option?.id || null;
}

/**
 * Add an issue to the GitHub Project V2 board
 */
async function addIssueToProject(issueNodeId, priority) {
  try {
    const { projectId, fields } = await getProjectMeta();
    const config = require('../config/users.json');

    // Add issue to project
    const addQuery = `
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item {
            id
          }
        }
      }
    `;

    const addResult = await graphqlWithAuth(addQuery, {
      projectId,
      contentId: issueNodeId
    });

    const itemId = addResult.addProjectV2ItemById.item.id;

    // Set priority field
    const priorityOptionId = getPriorityOptionId(fields, priority);
    if (priorityOptionId && fields['Priority']) {
      await updateProjectField(projectId, itemId, fields['Priority'].id, { singleSelectOptionId: priorityOptionId });
    }

    // Set default status (Todo)
    const statusOptionId = getStatusOptionId(fields, config.projectConfig.defaultStatus || 'Todo');
    if (statusOptionId && fields['Status']) {
      await updateProjectField(projectId, itemId, fields['Status'].id, { singleSelectOptionId: statusOptionId });
    }

    console.log(`✅ Added issue to project board`);
    return itemId;
  } catch (error) {
    console.error('Error adding to project:', error.message);
    // Don't throw - issue was created, just not added to project
    return null;
  }
}

/**
 * Update a project field value
 */
async function updateProjectField(projectId, itemId, fieldId, value) {
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: $value
      }) {
        projectV2Item { id }
      }
    }
  `;

  await graphqlWithAuth(mutation, {
    projectId,
    itemId,
    fieldId,
    value
  });
}

/**
 * Clear project cache (useful after config changes)
 */
function clearProjectCache() {
  projectCache = null;
}

module.exports = {
  getProjectMeta,
  mapAssignee,
  addIssueToProject,
  clearProjectCache
};