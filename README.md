# PalmPay Maldives (MVP)

Palm payments that plug into bank apps such as BML's and MIB's. The customer switches PalmPay on inside their bank's app, then pays at a shop counter by holding up their palm. The money comes straight from their bank account; PalmPay identifies the palm and asks the bank to approve.

This prototype has:

- **`/bank`**: a neutral demo bank app with the PalmPay module inside it (set up, choose account, set limit, turn off, palm payment history, live notifications).
- **`/terminal`**: a shop counter that stands in for the bank's card terminal (type amount, charge, palm scan, receipt).
- Two **simulated banks** (BML and MIB stand-ins) so both same-bank and Favara payments can be shown.

One Node.js app, Express as its only required dependency, no build step. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how each piece maps to production.

> Prototype. Banks and balances are simulated. Palm matching is hand geometry from a phone camera: fine for demos, not for real money.

## Run it on Replit

1. Create a Repl by importing this folder (upload the zip, or push it to GitHub and use **Import from GitHub**).
2. In the Shell: `npm install`. Then press **Run**.
3. Open the webview URL in a new browser tab (the camera does not work inside the embedded preview). Open the same URL on your phone for the scanner.

Demo data is created on first start. **Reset demo data** on the home page restores it. Run the tests with `npm test`.

## Demo script (3 minutes)

1. **Phone, `/bank`:** sign in as *Mariyam Shaheen (MIB, simulated)*. Tap **PalmPay**, then **Set up PalmPay**. Pick the account, a limit, tick the agreement, **Scan my palm**.
2. **Laptop, `/bank`:** sign in as Mariyam too, so the room can watch her balance.
3. **Phone, `/terminal`:** choose *Raalhu Café* (banks with BML), type 45.00, **Charge with palm**, hold up the same hand.
4. The laptop shows "Raalhu Café, MVR 45.00 paid with your palm", the balance counts down, and the statement says *via Favara*. The receipt shows the route: *Favara, MIB to BML*.
5. Try a payment above her limit to show a decline, or switch to *Hulhumalé Mart* (banks with MIB) to show a same-bank payment.

If the camera or lighting lets you down, use **No camera? Simulate a scan** and pick the customer. *Aishath Shiuna (BML)* already has PalmPay on in simulated mode.

## Settings

Defaults are in `.env.example`. Put changes in Replit **Secrets**.
