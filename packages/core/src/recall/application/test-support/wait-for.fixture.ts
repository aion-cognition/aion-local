/** Polls a substrate condition until it holds, for the fixtures that write through an index and read back before it catches up. */
export async function waitFor(label: string, ready: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await ready()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}
