export type Release = { version: string; date: string; title: string; changes: string[] };

/**
 * What changed in each version, newest first. Every delivery raises the version in package.json
 * and adds its entry here, in words the people using the panel understand. A test keeps both in step.
 */
export const releases: Release[] = [
  {
    version: '0.4.1',
    date: '2026-11-25',
    title: 'Cadastros organizados em abas',
    changes: [
      'O menu Cadastros agora tem três páginas: Produtos, Classificação e Comercial.',
      'Produtos reúne produtos, kits, tipos, famílias e unidades de medida em abas.',
      'Classificação reúne grupos, marcas, cores e departamentos, e Comercial reúne fornecedores e formas de pagamento.',
      'Cada aba tem seu próprio endereço, e os links antigos continuam abrindo a tela certa.',
    ],
  },
  {
    version: '0.4.0',
    date: '2026-11-24',
    title: 'Busca, filtros e PDF das ordens de produção',
    changes: [
      'Busque ordens pelo nome do produto, pelo SKU ou pelo número da ordem.',
      'Filtre a lista por situação, impressora e período de início.',
      'Cada ordem gera um PDF completo, que pode ser visto no app, baixado ou compartilhado.',
      'A coluna de produtos mostra um resumo e abre os detalhes de cada item na própria lista.',
      'Os botões das ordens foram reorganizados para computador, tablet e celular.',
    ],
  },
  {
    version: '0.3.1',
    date: '2026-11-24',
    title: 'Agenda do dia na ordem de produção',
    changes: [
      'Ao escolher o dia, a ordem mostra os horários em que a impressora já está ocupada.',
      'O início pode ser qualquer minuto, inclusive em dias passados, para lançar uma ordem esquecida.',
      'Se o horário colidir com outra ordem, a tela avisa e destaca a ordem que está bloqueando.',
    ],
  },
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
