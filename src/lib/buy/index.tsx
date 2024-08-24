import type { Command } from "commander";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import duration from "dayjs/plugin/duration";
import { logAndQuit } from "../../helpers/errors";
import { nullifyIfEmpty } from "../../helpers/empty";
import parseDuration from "parse-duration";
import { priceWholeToCenticents } from "../../helpers/units";
import * as chrono from "chrono-node";
import SFBuy from "./SFBuy";
import { renderCommand } from "../../ui/render";

dayjs.extend(relativeTime);
dayjs.extend(duration);

interface SfBuyOptions {
  nodes?: string;
  duration?: string;
  start?: string;
  price?: string;
  ioc?: boolean;
  yes?: boolean;
}

export function registerBuy(program: Command) {
  program
    .command("buy")
    .description("Place a buy order for compute")
    .option("-n, --nodes <quantity>", "Specify the number of nodes")
    .option(
      "-d, --duration <duration>",
      "Specify the duration (e.g. 1h, 1d, 1w)",
    )
    .option(
      "-s, --start <start>",
      "Specify the start date (e.g. 'at 2pm' or 'tomorrow at 3pm')",
    )
    .option(
      "-p, --price <price>",
      "Specify a limit price (the most you'd pay for the compute block)",
    )
    .option("--ioc", "Cancel immediately if not filled")
    .option("-y, --yes", "Automatically confirm and place the order")
    .action((options: SfBuyOptions) => {
      const argTotalNodes = options.nodes ? Number(options.nodes) : null;
      const argDurationSeconds = options.duration
        ? nullifyIfEmpty(parseDuration(options.duration, "s"))
        : null;

      // parse start at
      const startAtDate = options.start
        ? nullifyIfEmpty(chrono.parseDate(options.start as string))
        : null;
      const argStartAtIso = startAtDate?.toISOString() ?? null;

      // parse limit price
      const { centicents: argLimitPrice, invalid: argPriceInvalid } =
        priceWholeToCenticents(options.price);
      if (argPriceInvalid) {
        logAndQuit(`Invalid price: ${options.price}`); // TODO: remove this when validation properly moves into the component
        process.exit(1);
      }

      const argImmediateOrCancel = options.ioc ?? null;

      renderCommand(
        <SFBuy
          totalNodes={argTotalNodes}
          durationSeconds={argDurationSeconds}
          startAtIso={argStartAtIso}
          limitPrice={argLimitPrice}
          immediateOrCancel={argImmediateOrCancel}
        />,
      );
    });
}
