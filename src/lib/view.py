#!/usr/bin/env python3
import sys
import os

venv_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), '.venv', 'bin', 'python')
if sys.executable != venv_path:
    os.execv(venv_path, [venv_path] + sys.argv)

import re, subprocess, statistics
import argparse
from datetime import datetime, timedelta
from collections import namedtuple

import matplotlib.pyplot as plt
import matplotlib.patches as patches
from matplotlib.patches import Patch

Row = namedtuple('Row', ['Side', 'Status', 'Price', 'Quantity', 'Duration', 'Start', 'End', 'Price_per_Hour'])
def parse_duration(duration_str):
    total_hours = 0
    
    # Handle weeks
    if 'w' in duration_str:
        weeks, duration_str = duration_str.split('w')
        total_hours += int(weeks) * 7 * 24
    
    # Handle days
    if 'd' in duration_str:
        days, duration_str = duration_str.split('d')
        total_hours += int(days) * 24
    
    # Handle hours
    if 'h' in duration_str:
        hours, duration_str = duration_str.split('h')
        total_hours += int(hours)
    
    # Handle minutes
    if 'm' in duration_str:
        minutes = duration_str.rstrip('min')
        total_hours += int(minutes) / 60
    
    return total_hours

def parse_datetime(date_str):
    print(date_str)
    try:
        return datetime.strptime(date_str, '%m/%d/%Y, %I:%M:%S %p')
    except ValueError as e:
        unconverted_data = set(date_str) - set('0123456789/:, AMPM')
        for char in unconverted_data:
            date_str = date_str.replace(char, '')
        date_str = date_str.strip()
        return datetime.strptime(date_str, '%m/%d/%Y, %I:%M:%S %p')

def parse_data():
    result = subprocess.run(['sf', 'orders', 'ls', '--public'], capture_output=True)
    output = result.stdout.decode('utf-8', errors='ignore')
    lines = output.strip().split('\n')
    lines = [line.strip() for line in lines if '│' in line]

    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
    lines = [ansi_escape.sub('', line) for line in lines]
    # for line in lines:
    #     print(line)
    
    headers = [header.strip() for header in lines[0].split('│')][1:-1]
    # print(headers)
    data = []
    
    for line in lines[1:]:
        values = [value.strip() for value in line.split('│')[1:-1]]
        if len(values) == len(headers):
            row = dict(zip(headers, values))
            if row['Status'] == 'open':  # Remove the condition for 'sell' side
                price = float(row['Price'].replace('$', '').replace(',', ''))
                quantity = int(row['Quantity'])
                duration = parse_duration(row['Duration'])
                start = parse_datetime(row['Start'])
                end = start + timedelta(hours=duration)
                try:
                    price_per_hour = price / (duration * quantity * 8)
                except ZeroDivisionError:
                    print(f"ZeroDivisionError: {row}")
                    print(f"Price: {price}, Duration: {duration}, Quantity: {quantity}")
                    price_per_hour = 0
                
                data.append(Row(
                    Side=row['Side'],
                    Status=row['Status'],
                    Price=price,
                    Quantity=quantity,
                    Duration=duration,
                    Start=start,
                    End=end,
                    Price_per_Hour=price_per_hour
                ))
    
    return data

def plot_data(data, max_future=None):
    fig, ax = plt.subplots(figsize=(12, 6))
    
    now = datetime.now()
    
    for row in data:
        start_hours = (row.Start - now).total_seconds() / 3600
        end_hours = (row.End - now).total_seconds() / 3600
        
        if max_future is not None and start_hours > max_future:
            continue
        
        width = min(end_hours, max_future) - start_hours if max_future else end_hours - start_hours
        
        color = plt.cm.Set1(row.Quantity % 8)
        
        if row.Side == 'sell':
            rect = patches.Rectangle(
                (start_hours, row.Price_per_Hour - 0.05),
                width,
                0.1,
                fill=True,
                alpha=0.4,
                edgecolor='black',
                facecolor=color,
            )
        else:  # buy order
            rect = patches.Rectangle(
                (start_hours, row.Price_per_Hour - 0.05),
                width,
                0.1,
                fill=True,
                alpha=0.4,  # Reduced alpha for buy orders
                edgecolor='black',
                facecolor=color,
                hatch='///',
            )
        ax.add_patch(rect)
    
    ax.set_xlabel('Hours in the Future')
    ax.set_ylabel('Price per H100 Hour ($)')
    ax.set_title('H100 Pricing: Price per Hour vs Time')
    
    if max_future:
        ax.set_xlim(0, max_future)
    else:
        ax.set_xlim(0, max((row.End - now).total_seconds() / 3600 for row in data) + 1)
    
    y_max = max(row.Price_per_Hour for row in data) + 0.5
    ax.set_ylim(0, y_max)
    
    quantities = set(row.Quantity for row in data)
    legend_elements = [
        Patch(facecolor=plt.cm.Set1(q % 8), edgecolor='black', label=f'Quantity: {q}') for q in quantities
    ] + [
        Patch(facecolor='gray', edgecolor='black', alpha=0.7, label='Sell Order'),
        Patch(facecolor='gray', edgecolor='black', alpha=0.4, hatch='///', label='Buy Order')
    ]
    ax.legend(handles=legend_elements, loc='upper right')
    
    ax.grid(True, linestyle='--', alpha=0.7)
    plt.tight_layout()
    plt.show()

def print_statistics(data):
    sell_prices_per_hour = [row.Price_per_Hour for row in data if row.Side == 'sell']
    print("Average price per H100 hour (sell orders):", statistics.mean(sell_prices_per_hour))
    print("Median price per H100 hour (sell orders):", statistics.median(sell_prices_per_hour))
    print("Min price per H100 hour (sell orders):", min(sell_prices_per_hour))
    print("Max price per H100 hour (sell orders):", max(sell_prices_per_hour))

def main():
    parser = argparse.ArgumentParser(description='Plot H100 pricing data')
    parser.add_argument('--max-future', type=float, help='Maximum number of hours into the future to graph')
    args = parser.parse_args()

    data = parse_data()
    plot_data(data, args.max_future)
    print_statistics(data)

if __name__ == "__main__":
    main()