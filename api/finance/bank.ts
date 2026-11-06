export type BankEntry = { id: string | null; date: string; amount: string; direction: string; type: string; title: string; description: string };

export interface BankReader {
  balance(): Promise<string>;
  statement(from: string, to: string): Promise<BankEntry[]>;
}
