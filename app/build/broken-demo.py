# A small stock report with three real bugs in it.
#
# Run it, and it prints a total of 0 and then crashes. Use it to check that
# screen assist and the Magic Editor can both find and fix a fault they can
# only see on screen.
#
#     python broken-demo.py
#
# What is actually wrong, so you can mark their answers:
#   1. total is reset to 0 inside the loop, so only the last row ever counts.
#   2. The average divides by len(rows) + 1, so it is always a little low.
#   3. low_stock compares a str to an int, which is the crash at the end.

rows = [
    {"name": "Widget",  "qty": "12", "price": 4.50},
    {"name": "Gasket",  "qty": "8",  "price": 1.25},
    {"name": "Bearing", "qty": "30", "price": 9.99},
    {"name": "Washer",  "qty": "100", "price": 0.10},
]


def stock_value(rows):
    total = 0
    for row in rows:
        total = 0                      # bug 1
        total += int(row["qty"]) * row["price"]
    return total


def average_price(rows):
    return sum(r["price"] for r in rows) / (len(rows) + 1)      # bug 2


def low_stock(rows, threshold=10):
    return [r["name"] for r in rows if r["qty"] < threshold]    # bug 3


print("Total stock value:", stock_value(rows))
print("Average price:    ", round(average_price(rows), 2))
print("Low stock:        ", low_stock(rows))
