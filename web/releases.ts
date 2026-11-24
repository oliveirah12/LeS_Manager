export type Release = { version: string; date: string; title: string; changes: string[] };

/**
 * What changed in each version, newest first. Every delivery raises the version in package.json
 * and adds its entry here, in words the people using the panel understand. A test keeps both in step.
 */
export const releases: Release[] = [
  {
    version: '0.3.0',
    date: '2026-11-24',
    title: 'Agenda das ordens de produção',
    changes: [
      'As ordens de produção agora aparecem da data de início mais recente para a mais antiga.',
      'Ao criar ou editar uma ordem, escolha o início em um calendário que mostra só os horários livres da impressora.',
      'O sistema não deixa marcar duas impressões no mesmo horário na mesma impressora.',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-11-22',
    title: 'Compras, arquivos e ordem de produção comercial',
    changes: [
      'Produtos agora têm imagem, mostrada na lista do catálogo.',
      'Novo aviso de versões, com o que mudou em cada atualização.',
      'Todas as tabelas ordenam pelas colunas, e os campos de seleção têm busca.',
      'O cadastro do produto reúne dimensões, URL de compra, estoque mínimo, margem e preço sugerido.',
      'Produtos aceitam arquivos anexados, incluídos no backup diário.',
      'Compras com vários itens, fornecedor, data, custos adicionais, rateio e estorno.',
      'Documentos de compra ganharam anexos e uma página de busca com filtros.',
      'Ordens de produção têm preço, desconto, forma de pagamento, despesas e filamento substituto.',
      'Ordens planejadas podem ser editadas, e as concluídas aceitam correção técnica auditada.',
    ],
  },
];

export const currentVersion = releases[0].version;
