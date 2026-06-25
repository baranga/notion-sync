import readline from "node:readline";

/**
 * Ask the user a question on the terminal and resolve with their trimmed
 * answer. Reads from stdin and writes the prompt to stderr so it never mixes
 * with command output on stdout (which may be piped or redirected).
 */
export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
