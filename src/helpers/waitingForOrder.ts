import chalk from "chalk";
import ora from "ora";
import { logAndQuit } from "./errors";
import { getOrder } from "./fetchers";

export async function waitForOrderToNotBePending(orderId: string, consoleLog: boolean = true) {
  let spinner;
  if (consoleLog) {
    spinner = ora(
      `Order ${orderId} - pending (this can take a moment)`,
    ).start();
  }
  const maxTries = 500;
  for (let i = 0; i < maxTries; i++) {
    const order = await getOrder(orderId);

    if (order && order?.status !== "pending") {
      if (spinner) {
        spinner.text = `Order ${orderId} - ${order?.status}`;
        spinner.succeed();
        console.log(chalk.green("Order placed successfully"));
      }
      return order;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (spinner) {
    spinner.fail();
  }
  logAndQuit(`Order ${orderId} - possibly failed`);
}
