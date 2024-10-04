import { confirm } from "@inquirer/prompts";
import c from "chalk";
import type { Command } from "commander";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";
import relativeTime from "dayjs/plugin/relativeTime";
import parseDuration from "parse-duration";
import { apiClient } from "../apiClient";
import { isLoggedIn } from "../helpers/config";
import {
  logAndQuit,
  logLoginMessageAndQuit,
  logSessionTokenExpiredAndQuit,
} from "../helpers/errors";
import {
  pricePerGPUHourToTotalPriceCents,
  totalPriceToPricePerGPUHour,
} from "../helpers/price";
import {
  type Cents,
  centsToDollarsFormatted,
  computeApproximateDurationSeconds,
  parseStartDate,
  priceWholeToCents,
  roundEndDate,
  roundStartDate,
} from "../helpers/units";
import { waitForOrderToNotBePending } from "../helpers/waitingForOrder";
import type { Nullable } from "../types/empty";
import { GPUS_PER_NODE } from "./constants";
import { formatDuration } from "./orders";

dayjs.extend(relativeTime);
dayjs.extend(duration);

interface SfBuyOptions {
  type: string;
  accelerators?: string;
  duration: string;
  price: string;
  start?: string;
  yes?: boolean;
  quote?: boolean;
  split?: boolean;
}

export function registerBuy(program: Command) {
  program
    .command("buy")
    .description("Place a buy order")
    .requiredOption("-t, --type <type>", "Specify the type of node", "h100i")
    .option("-n, --accelerators <quantity>", "Specify the number of GPUs", "8")
    .requiredOption("-d, --duration <duration>", "Specify the duration", "1h")
    .option("-p, --price <price>", "The price in dollars, per GPU hour")
    .option(
      "-s, --start <start>",
      "Specify the start date. Can be a date, relative time like '+1d', or the string 'NOW'",
    )
    .option("-y, --yes", "Automatically confirm the order")
    .option("--quote", "Only provide a quote for the order")
    .option("--split", "Split the order into multiple smaller orders")
    .action(buyOrderAction);
}

async function buyOrderAction(options: SfBuyOptions) {
  const loggedIn = await isLoggedIn();
  if (!loggedIn) {
    return logLoginMessageAndQuit();
  }

  // normalize inputs

  const isQuoteOnly = options.quote ?? false;
  const isSplit = options.split ?? false;

  // parse duration
  let durationSeconds = parseDuration(options.duration, "s");
  if (!durationSeconds) {
    return logAndQuit(`Invalid duration: ${options.duration}`);
  }

  // default to 1 node if not specified
  const accelerators = options.accelerators ? Number(options.accelerators) : 1;

  if (accelerators % GPUS_PER_NODE !== 0) {
    const exampleCommand = `sf buy -n ${GPUS_PER_NODE} -d "${options.duration}"`;
    return logAndQuit(
      `At the moment, only entire-nodes are available, so you must have a multiple of ${GPUS_PER_NODE} GPUs. Example command:\n\n${exampleCommand}`,
    );
  }
  const quantity = Math.ceil(accelerators / GPUS_PER_NODE);

  // parse price
  let priceCents: Nullable<Cents> = null;
  if (options.price) {
    const { cents: priceCentsParsed, invalid: priceInputInvalid } =
      priceWholeToCents(options.price);
    if (priceInputInvalid) {
      return logAndQuit(`Invalid price: ${options.price}`);
    }
    priceCents = priceCentsParsed;
  }

  const yesFlagOmitted = options.yes === undefined || options.yes === null;
  const confirmWithUser = yesFlagOmitted || !options.yes;

  // parse starts at
  let startDate: Date | "NOW";
  switch (options.start) {
    case null:
    case undefined:
      startDate = "NOW";
      break;
    default: {
      const parsed = parseStartDate(options.start);
      if (!parsed) {
        return logAndQuit(`Invalid start date: ${options.start}`);
      }
      startDate = parsed;
    }
  }

  let endDate: Date = dayjs(startDate === "NOW" ? new Date() : startDate)
    .add(durationSeconds, "s")
    .toDate();
  let didQuote = false;
  if (options.quote) {
    const quote = await getQuote({
      instanceType: options.type,
      quantity: quantity,
      startsAt: startDate,
      durationSeconds,
    });

    if (!quote) {
      return logAndQuit("Not enough data exists to quote this order.");
    }

    startDate = quote.start_at === "NOW" ? "NOW" : new Date(quote.start_at);
    endDate = new Date(quote.end_at);
    durationSeconds = computeApproximateDurationSeconds(startDate, endDate);

    const priceLabelUsd = c.green(centsToDollarsFormatted(quote.price));
    const priceLabelPerGPUHour = c.green(
      centsToDollarsFormatted(
        totalPriceToPricePerGPUHour(
          quote.price,
          durationSeconds,
          quantity,
          GPUS_PER_NODE,
        ),
      ),
    );

    console.log(
      `Found availability from ${c.green(quote.start_at)} to ${c.green(
        quote.end_at,
      )} (${c.green(
        formatDuration(durationSeconds * 1000),
      )}) at ${priceLabelUsd} total (${priceLabelPerGPUHour}/GPU-hour)`,
    );
    didQuote = true;
  } else if (!priceCents) {
    const quote = await getQuote({
      instanceType: options.type,
      quantity: quantity,
      startsAt: startDate,
      durationSeconds,
    });

    if (!quote) {
      const durationInHours = durationSeconds / 3600;

      console.log(`No one is selling this right now. To ask someone to sell it to you, add a price you're willing to pay. For example:

  sf buy -d "${durationInHours}h" -n ${quantity * GPUS_PER_NODE} -p "2.50" 
        `);

      return process.exit(1);
    }

    startDate = quote.start_at === "NOW" ? "NOW" : new Date(quote.start_at);
    endDate = new Date(quote.end_at);
    durationSeconds = computeApproximateDurationSeconds(startDate, endDate);
    priceCents = quote.price;
    didQuote = true;
  }

  if (!durationSeconds) {
    throw new Error("unexpectedly no duration provided");
  }
  if (!priceCents) {
    throw new Error("unexpectedly no price provided");
  }

  // Handle --split option
  if (isSplit) {
    // Check that start date is specified
    if (!options.start) {
      return logAndQuit(
        "--split option requires a start date to be specified using --start",
      );
    }

    // Check that duration is an integer number of hours
    if (durationSeconds % 3600 !== 0) {
      return logAndQuit(
        "--split option requires duration to be an integer number of hours",
      );
    }

    // Check that price is specified
    if (!priceCents) {
      return logAndQuit("--split option requires price to be specified using --price");
    }

    const M = quantity; // number of nodes
    const N = durationSeconds / 3600; // number of hours

    const pricePerGPUHourCents = priceCents
    const totalPriceCents = pricePerGPUHourCents * GPUS_PER_NODE * M * N
    
    // Compute price per order
    const pricePerOrderCents = pricePerGPUHourCents * GPUS_PER_NODE * 1; // 1 hour

    if (confirmWithUser) {
      const confirmationMessage = confirmPlaceSplitOrderMessage({
        instanceType: options.type,
        priceCents: totalPriceCents,
        quantity,
        durationSeconds,
        startsAt: startDate,
        endsAt: endDate,
        M,
        N,
        pricePerGPUHourCents,
      });
      const confirmed = await confirm({
        message: confirmationMessage,
        default: false,
      });

      if (!confirmed) {
        return logAndQuit("Order cancelled");
      }
    }

    // Collect all promises
    const orderPromises = [];

    for (let hourIndex = 0; hourIndex < N; hourIndex++) {
      const orderStartDate = dayjs(startDate === "NOW" ? new Date() : startDate)
        .add(hourIndex, "hour")
        .toDate();
      const orderEndDate = dayjs(orderStartDate).add(1, "hour").toDate();

      for (let nodeIndex = 0; nodeIndex < M; nodeIndex++) {
        // Place the order
        const orderPromise = placeBuyOrder({
          instanceType: options.type,
          priceCents: pricePerOrderCents,
          quantity: 1,
          startsAt: orderStartDate,
          endsAt: orderEndDate,
          confirmWithUser: false,
          quoteOnly: isQuoteOnly,
        }).then((res) =>
          waitForOrderToNotBePending(res.id, { consoleLog: false }),
        );

        orderPromises.push(orderPromise);
      }
    }

    // Wait for all orders to be placed
    console.log(`Placing ${orderPromises.length} orders...`);

    const orders = await Promise.all(orderPromises);

    // Process the orders
    const filledOrders = orders.filter((order) => order.status === "filled");
    const openOrders = orders.filter((order) => order.status === "open");

    if (filledOrders.length > 0) {
      console.log(
        `Successfully placed and filled ${filledOrders.length} orders.`,
      );
    }

    if (openOrders.length > 0) {
      console.log(
        `${openOrders.length} orders are still open. You can check their status with:

    sf orders ls

If you want to cancel the orders, you can do so with:

    sf orders cancel [order_id]

        `,
      );
    }

    return;
  }

  // if we didn't quote, we need to round the start and end dates
  if (!didQuote) {
    // round the start date if it's not "NOW".
    const roundedStartDate =
      startDate !== "NOW" ? roundStartDate(startDate) : startDate;

    // round the end date.
    const roundedEndDate = roundEndDate(endDate);

    // if we rounded the time, prorate the price
    const roundedDurationSeconds = computeApproximateDurationSeconds(
      roundedStartDate,
      roundedEndDate,
    );

    const priceCentsPerSecond = priceCents / durationSeconds;
    const roundedPriceCents = priceCentsPerSecond * roundedDurationSeconds;

    priceCents = roundedPriceCents;
    startDate = roundedStartDate;
    endDate = roundedEndDate;
    durationSeconds = roundedDurationSeconds;
  }

  if (confirmWithUser) {
    const confirmationMessage = confirmPlaceOrderMessage({
      instanceType: options.type,
      priceCents,
      quantity,
      durationSeconds,
      startsAt: startDate,
      endsAt: endDate,
      confirmWithUser,
      quoteOnly: isQuoteOnly,
    });
    const confirmed = await confirm({
      message: confirmationMessage,
      default: false,
    });

    if (!confirmed) {
      logAndQuit("Order cancelled");
    }
  }

  const res = await placeBuyOrder({
    instanceType: options.type,
    priceCents,
    quantity,
    // round start date again because the user might have taken a long time to confirm
    // most of the time this will do nothing, but when it does it will move the start date forwrd one minute
    startsAt: startDate === "NOW" ? "NOW" : roundStartDate(startDate),
    endsAt: endDate,
    confirmWithUser,
    quoteOnly: isQuoteOnly,
  });

  const order = await waitForOrderToNotBePending(res.id);
  if (!order) {
    return;
  }

  if (order.status === "filled") {
    const now = new Date();
    const startAt = new Date(order.start_at);
    const timeDiff = startAt.getTime() - now.getTime();
    const oneMinuteInMs = 60 * 1000;

    if (now >= startAt || timeDiff <= oneMinuteInMs) {
      console.log(`Your nodes are currently spinning up. Once they're online, you can view them using:

  sf instances ls

`);
    } else {
      const contractStartTime = dayjs(startAt);
      const timeFromNow = contractStartTime.fromNow();
      console.log(`Your contract begins ${c.green(
        timeFromNow,
      )}. You can view more details using:

  sf contracts ls

`);
    }
    return;
  }

  if (order.status === "open") {
    console.log(`Your order wasn't accepted yet. You can check its status with:

        sf orders ls
  
      If you want to cancel the order, you can do so with:
  
        sf orders cancel ${order.id}
  
        `);
    return;
  }

  console.error(`Order likely did not execute. Check the status with:

      sf orders ls

    `);
}

function confirmPlaceOrderMessage(options: BuyOptions) {
  if (!options.priceCents) {
    return "";
  }

  const totalNodesLabel = c.green(options.quantity);
  const instanceTypeLabel = c.green(options.instanceType);
  const nodesLabel = options.quantity > 1 ? "nodes" : "node";

  const durationHumanReadable = formatDuration(options.durationSeconds * 1000);
  const endsAtLabel = c.green(dayjs(options.endsAt).format("MM/DD/YYYY hh:mm A"));
  const fromNowTime = dayjs(
    options.startsAt === "NOW" ? new Date() : options.startsAt,
  ).fromNow();

  let timeDescription: string;
  if (
    fromNowTime === "a few seconds ago" ||
    fromNowTime === "in a few seconds"
  ) {
    timeDescription = `from ${c.green("now")} until ${endsAtLabel}`;
  } else {
    const startAtLabel = c.green(
      options.startsAt === "NOW"
        ? "NOW"
        : dayjs(options.startsAt).format("MM/DD/YYYY hh:mm A"),
    );
    timeDescription = `from ${startAtLabel} (${c.green(
      fromNowTime,
    )}) until ${endsAtLabel}`;
  }

  const pricePerGPUHour = totalPriceToPricePerGPUHour(
    options.priceCents,
    options.durationSeconds,
    options.quantity,
    GPUS_PER_NODE,
  );
  const pricePerHourLabel = c.green(centsToDollarsFormatted(pricePerGPUHour));
  const totalPriceLabel = c.green(centsToDollarsFormatted(options.priceCents));

  const topLine = `${totalNodesLabel} ${instanceTypeLabel} ${nodesLabel} (${
    GPUS_PER_NODE * options.quantity
  } GPUs) at ${pricePerHourLabel} per GPU hour for ${c.green(
    durationHumanReadable,
  )} ${timeDescription} for a total of ${totalPriceLabel}`;

  const dollarsLabel = c.green(centsToDollarsFormatted(pricePerGPUHour));

  const gpusLabel = c.green(options.quantity * GPUS_PER_NODE);

  const priceLine = `\nBuy ${gpusLabel} GPUs at ${dollarsLabel} per GPU hour?`;

  return `${topLine}\n${priceLine} `;
}

function confirmPlaceSplitOrderMessage(options: BuySplitOptions) {
  const totalOrders = options.M * options.N;
  const totalNodesLabel = c.green(options.M);
  const totalHoursLabel = c.green(options.N);
  const totalOrdersLabel = c.green(totalOrders);
  const instanceTypeLabel = c.green(options.instanceType);
  const nodesLabel = options.M > 1 ? "nodes" : "node";
  const durationHumanReadable = formatDuration(options.durationSeconds * 1000);

  const startsAtLabel = c.green(
    options.startsAt === "NOW"
      ? "NOW"
      : dayjs(options.startsAt).format("MM/DD/YYYY hh:mm A"),
  );

  const endsAtLabel = c.green(dayjs(options.endsAt).format("MM/DD/YYYY hh:mm A"));

  const pricePerGPUHourLabel = c.green(
    centsToDollarsFormatted(options.pricePerGPUHourCents),
  );
  const totalPriceLabel = c.green(centsToDollarsFormatted(options.priceCents));

  const message = `You are about to place ${totalOrdersLabel} orders, each for 1 ${instanceTypeLabel} node (${GPUS_PER_NODE} GPUs) for 1 hour, starting from ${startsAtLabel}, at ${pricePerGPUHourLabel} per GPU-hour, totaling ${totalPriceLabel}.\nDo you want to proceed?`;

  return message;
}

type BuyOptions = {
  instanceType: string;
  priceCents: number;
  quantity: number;
  startsAt: Date | "NOW";
  endsAt: Date;
  durationSeconds: number;
  confirmWithUser: boolean;
  quoteOnly: boolean;
};

type BuySplitOptions = {
  instanceType: string;
  priceCents: number;
  quantity: number;
  durationSeconds: number;
  startsAt: Date | "NOW";
  endsAt: Date;
  M: number;
  N: number;
  pricePerGPUHourCents: number;
};

export async function placeBuyOrder(options: Omit<BuyOptions, "durationSeconds">) {
  const api = await apiClient();
  const { data, error, response } = await api.POST("/v0/orders", {
    body: {
      side: "buy",
      instance_type: options.instanceType,
      quantity: options.quantity,
      start_at:
        options.startsAt === "NOW"
          ? "NOW"
          : roundStartDate(options.startsAt).toISOString(),
      end_at: options.endsAt.toISOString(),
      price: options.priceCents,
    },
  });

  if (!response.ok) {
    switch (response.status) {
      case 400:
        return logAndQuit(`Bad Request: ${error?.message}`);
      case 401:
        return await logSessionTokenExpiredAndQuit();
      case 500:
        return logAndQuit(`Failed to place order: ${error?.message}`);
      default:
        return logAndQuit(`Failed to place order: ${response.statusText}`);
    }
  }

  if (!data) {
    return logAndQuit(
      `Failed to place order: Unexpected response from server: ${response}`,
    );
  }

  return data;
}

type QuoteOptions = {
  instanceType: string;
  quantity: number;
  startsAt: Date | "NOW";
  durationSeconds: number;
};
export async function getQuote(options: QuoteOptions) {
  const api = await apiClient();

  const { data, error, response } = await api.GET("/v0/quote", {
    params: {
      query: {
        side: "buy",
        instance_type: options.instanceType,
        quantity: options.quantity,
        duration: options.durationSeconds,
        min_start_date:
          options.startsAt === "NOW"
            ? "NOW"
            : options.startsAt.toISOString(),
        max_start_date:
          options.startsAt === "NOW"
            ? "NOW"
            : options.startsAt.toISOString(),
      },
    },
  });

  if (!response.ok) {
    switch (response.status) {
      case 400:
        return logAndQuit(`Bad Request: ${error?.message}`);
      case 401:
        return await logSessionTokenExpiredAndQuit();
      case 500:
        return logAndQuit(`Failed to get quote: ${error?.code}`);
      default:
        return logAndQuit(`Failed to get quote: ${response.statusText}`);
    }
  }

  if (!data) {
    return logAndQuit(
      `Failed to get quote: Unexpected response from server: ${response}`,
    );
  }

  return data.quote;
}