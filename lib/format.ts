// Display helpers shared by the server and the browser (no server-only imports here).
export function clock(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

export const money = (n: number, currency: string) =>
  new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);

export const day = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00`));

export const span = (start: number, end: number) => `${clock(start)} to ${clock(end)}`;

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
