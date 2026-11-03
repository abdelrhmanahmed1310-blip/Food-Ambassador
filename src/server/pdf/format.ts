import "server-only";
import { getLocale } from "next-intl/server";

/** Number and date formatting for PDFs in the user's language (Latin digits). */
export async function pdfFormat() {
  const locale = `${await getLocale()}-u-nu-latn`;
  const num = (digits: number) =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const qty = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  return {
    money: (v: { toString(): string }, currency: string) =>
      `${num(2).format(Number(v.toString()))} ${currency}`,
    price: (v: { toString(): string }) =>
      new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(
        Number(v.toString()),
      ),
    quantity: (v: { toString(): string }) => qty.format(Number(v.toString())),
    percent: (v: { toString(): string }) =>
      `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Number(v.toString()) * 100)} %`,
    date: (d: Date) => d.toISOString().slice(0, 10),
  };
}
