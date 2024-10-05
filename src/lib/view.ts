import type { Command } from "commander";
import Table from "cli-table3";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";
import relativeTime from "dayjs/plugin/relativeTime";
import { getOrders } from "./orders";
import { isLoggedIn } from "../helpers/config";
import {
  logLoginMessageAndQuit,
  logAndQuit,
} from "../helpers/errors";

dayjs.extend(relativeTime);
dayjs.extend(duration);

export function registerView(program: Command) {
  const viewCommand = program
    .command("view")
    .description("Display view");

  viewCommand
    .command("overview")
    .description("Display view overview")
    .option(
      "--max-future <hours>",
      "Maximum number of hours into the future to display",
      parseFloat
    )
    .action(async (options) => {
      await showMarketOverview(options.maxFuture);
    });
}

interface OrderRow {
  Side: string;
  Status: string;
  Price: number;
  Quantity: number;
  Duration: number; // in hours
  Start: Date;
  End: Date;
  Price_per_Hour: number;
}

async function showMarketOverview(maxFutureHours?: number) {
  const data = await parseData();
  plotData(data, maxFutureHours);
  printStatistics(data);
}

async function parseData(): Promise<OrderRow[]> {
  const loggedIn = await isLoggedIn();
  if (!loggedIn) {
    logLoginMessageAndQuit();
  }

  const orders = await getOrders({
    side: "sell",
    only_open: true,
    include_public: true,
  });

  const data: OrderRow[] = [];

  for (const order of orders) {
    if (order.status === "open") {
      const price = order.price / 100; // Assuming price is in cents
      const quantity = order.quantity;
      const start = new Date(order.start_at);
      const end = new Date(order.end_at);
      const durationMs = end.getTime() - start.getTime();
      const durationHrs = durationMs / (1000 * 60 * 60);

      const price_per_hour = price / (durationHrs * quantity * 8); // Adjust as needed

      data.push({
        Side: order.side,
        Status: order.status,
        Price: price,
        Quantity: quantity,
        Duration: durationHrs,
        Start: start,
        End: end,
        Price_per_Hour: price_per_hour,
      });
    }
  }

  return data;
}

function plotData(data: OrderRow[], maxFuture?: number) {
  const now = new Date();

  data.sort((a, b) => a.Start.getTime() - b.Start.getTime());

  const table = new Table({
    head: ["Start in Future (hrs)", "Price per Hour ($)", "Quantity"],
  });

  for (const row of data) {
    const startHours = (row.Start.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (maxFuture !== undefined && startHours > maxFuture) {
      continue;
    }
    table.push([
      startHours.toFixed(2),
      row.Price_per_Hour.toFixed(2),
      row.Quantity,
    ]);
  }

  console.log(table.toString());
}

function printStatistics(data: OrderRow[]) {
  const sellPricesPerHour = data
    .filter((row) => row.Side === "sell")
    .map((row) => row.Price_per_Hour);

  const sum = sellPricesPerHour.reduce((acc, val) => acc + val, 0);
  const avg = sum / sellPricesPerHour.length;
  const median =
    sellPricesPerHour.sort((a, b) => a - b)[
      Math.floor(sellPricesPerHour.length / 2)
    ];
  const min = Math.min(...sellPricesPerHour);
  const max = Math.max(...sellPricesPerHour);

  console.log(
    "Average price per H100 hour (sell orders):",
    avg.toFixed(2)
  );
  console.log(
    "Median price per H100 hour (sell orders):",
    median.toFixed(2)
  );
  console.log("Min price per H100 hour (sell orders):", min.toFixed(2));
  console.log("Max price per H100 hour (sell orders):", max.toFixed(2));
}