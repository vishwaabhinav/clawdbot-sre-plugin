import * as fs from "fs";
import * as path from "path";

const MEMORY_PATH = process.env.MEMORY_PATH || path.join(process.env.HOME || "", "clawd", "MEMORY.md");

interface KnownIssue {
  title: string;
  date: string;
  symptoms: string;
  rootCause: string;
  fix: string;
  prevention?: string;
}

/**
 * Parse MEMORY.md to extract known issues
 */
function parseMemory(): KnownIssue[] {
  const issues: KnownIssue[] = [];
  
  try {
    if (!fs.existsSync(MEMORY_PATH)) {
      return issues;
    }
    
    const content = fs.readFileSync(MEMORY_PATH, "utf-8");
    
    // Find the "Known Issues & Fixes" section
    const issuesMatch = content.match(/## Known Issues & Fixes\n([\s\S]*?)(?=\n## |$)/);
    if (!issuesMatch) return issues;
    
    const issuesSection = issuesMatch[1];
    
    // Parse each issue block (starts with ###)
    const issueBlocks = issuesSection.split(/\n### /).slice(1);
    
    for (const block of issueBlocks) {
      const lines = block.split("\n");
      const title = lines[0]?.trim() || "";
      
      // Extract fields
      const getField = (name: string): string => {
        const match = block.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`, "i"));
        return match ? match[1].trim() : "";
      };
      
      const issue: KnownIssue = {
        title,
        date: getField("First seen"),
        symptoms: getField("Symptoms"),
        rootCause: getField("Root cause"),
        fix: getField("Fix"),
        prevention: getField("Prevention"),
      };
      
      if (issue.title && issue.fix) {
        issues.push(issue);
      }
    }
  } catch (error) {
    console.error("Error parsing MEMORY.md:", error);
  }
  
  return issues;
}

/**
 * Find similar issues based on error title/function
 */
export function findSimilarIssues(errorTitle: string, functionName: string): KnownIssue[] {
  const issues = parseMemory();
  const matches: KnownIssue[] = [];
  
  const searchTerms = [
    ...errorTitle.toLowerCase().split(/\s+/),
    ...functionName.toLowerCase().split(/[.:]/),
  ].filter(t => t.length > 3);
  
  for (const issue of issues) {
    const issueText = `${issue.title} ${issue.symptoms} ${issue.rootCause}`.toLowerCase();
    
    // Count matching terms
    const matchCount = searchTerms.filter(term => issueText.includes(term)).length;
    
    // If more than 30% of terms match, consider it similar
    if (matchCount > 0 && matchCount / searchTerms.length >= 0.3) {
      matches.push(issue);
    }
  }
  
  return matches;
}

/**
 * Format a suggestion based on similar issues
 */
export function formatSuggestion(similar: KnownIssue[]): string {
  if (similar.length === 0) return "";
  
  const best = similar[0];
  let suggestion = `\n\n💡 *Similar to:* ${best.title}`;
  if (best.date) suggestion += ` (${best.date})`;
  suggestion += `\n*Suggested fix:* ${best.fix}`;
  
  return suggestion;
}
