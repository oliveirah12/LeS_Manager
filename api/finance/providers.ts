import { BadRequestException } from '@nestjs/common';
import { BankReader } from './bank';
import { InterReader } from './inter';

export type BankProvider = { id: string; name: string; open: () => BankReader };

export const providers: readonly BankProvider[] = [
  { id: 'inter', name: 'Inter Empresas', open: () => InterReader.fromEnv() },
];

export function bankProvider(id?: string) {
  const provider = id === undefined ? providers[0] : providers.find(item => item.id === id);
  if (!provider) throw new BadRequestException('Provedor bancário desconhecido.');
  return provider;
}
