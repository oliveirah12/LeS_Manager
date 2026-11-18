import { BadRequestException } from '@nestjs/common';
import { BankReader } from './bank';
import { InterConfig, InterReader } from './inter';

/** A bank the panel can connect to. connect builds the reader from the credentials saved in the panel. */
export type BankProvider = { id: string; name: string; connect: (config: InterConfig) => BankReader };
/** What a refresh needs: the provider and a way to obtain its reader. */
export type BankSource = Pick<BankProvider, 'id' | 'name'> & { open: () => BankReader | Promise<BankReader> };

export const providers: readonly BankProvider[] = [
  { id: 'inter', name: 'Inter Empresas', connect: config => InterReader.fromConfig(config) },
];

export function bankProvider(id?: string) {
  const provider = id === undefined ? providers[0] : providers.find(item => item.id === id);
  if (!provider) throw new BadRequestException('Provedor bancário desconhecido.');
  return provider;
}
