export const TEST_COMPACTION_REQUEST_MESSAGE = `Compact the conversation above into a concise handoff summary now. Preserve the user's goals, important decisions, constraints, relevant file paths, changes already made, command and test results, unresolved errors, and concrete next steps. If a complete final answer or deliverable is drafted but not yet delivered, include it - verbatim when it fits a concise summary, otherwise tightly condensed - and mark it as the finished answer. Do not call tools. Return only the summary.`;

export const TEST_COMPACTION_HANDOFF_INSTRUCTION = `Treat the summary below as prior context and continue from it. If it contains a finished answer or deliverable that was never delivered, deliver it now instead of repeating research or verification:`;

export function testCompactionHandoffMessage(summary: string): string {
  return `Conversation compacted:\n\n${TEST_COMPACTION_HANDOFF_INSTRUCTION}\n\n${summary}`;
}
