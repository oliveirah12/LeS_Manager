export type Release = { version: string; date: string; title: string; changes: string[] };

/**
 * What changed in each version, newest first. Every delivery raises the version in package.json
 * and adds its entry here, in words the people using the panel understand. A test keeps both in step.
 */
export const releases: Release[] = [
  {
    version: '0.9.0',
    date: '2026-11-26',
    title: 'Orçamentos',
    changes: [
      'Novo menu Orçamentos, com busca por cliente, título, produto ou número e filtros por situação e período.',
      'O orçamento reúne cliente, título, descrição, detalhes livres (como tamanho e cores), produtos, tempo, placas, prazo de entrega, validade, despesas, desconto e forma de pagamento.',
      'A validade vem sugerida pelo cadastro da empresa, e o preço de cada produto parte do cadastro e pode ser ajustado.',
      'O PDF para o cliente traz o logo e o rodapé da empresa, a imagem do produto, a tabela do pedido e o valor total em destaque. Ele nunca mostra custos, insumos, margem nem a observação interna.',
      'Situações: Rascunho, Enviado, Aprovado e Recusado. Rascunho e Enviado podem ser editados, e só o Recusado pode ser excluído.',
      'Aprovar pede o dia e o horário na agenda da impressora e cria a ordem de produção planejada com os mesmos itens, preços, desconto e despesas. Para aprovar é preciso também operar a Produção.',
      'Quem vê o Estoque enxerga o custo estimado, o preço sugerido e a margem real de cada orçamento.',
      'Nova permissão Orçamentos nos perfis de acesso. Impressoras, formas de pagamento e produtos usados em orçamentos não podem ser excluídos.',
    ],
  },
  {
    version: '0.8.0',
    date: '2026-11-25',
    title: 'Cadastro da empresa',
    changes: [
      'Nova aba Empresa em Cadastros › Comercial, com nome, slogan, contato, rodapé, logo e a validade padrão dos orçamentos.',
      'O logo aceita JPG, PNG ou WebP e só é enviado ao clicar em Salvar, junto com os outros dados.',
      'O botão Prévia do PDF mostra um orçamento de exemplo com o cabeçalho, o valor total em destaque e o rodapé da empresa.',
      'Esses dados vão para o cabeçalho e o rodapé dos orçamentos, que chegam na próxima versão.',
      'A auditoria registra cada alteração dos dados da empresa, inclusive a troca do logo.',
    ],
  },
  {
    version: '0.7.0',
    date: '2026-11-25',
    title: 'Produto salvo de uma vez',
    changes: [
      'O cadastro do produto virou um formulário só, com as seções Dados, Imagem e arquivos, Ficha técnica e Formação de preço.',
      'Imagem e arquivos podem ser escolhidos já no cadastro de um produto novo. Eles são enviados ao clicar em Salvar, junto com o resto.',
      'Um único Salvar grava os dados, a imagem, os arquivos, a ficha técnica e o preço. Se algo der errado, nada é gravado pela metade.',
      'A formação de preço de um produto novo já mostra o preço sugerido pela ficha técnica que está sendo montada.',
      'A auditoria registra o cadastro ou a alteração do produto num único evento, com imagem, arquivos, ficha e preço.',
    ],
  },
  {
    version: '0.6.0',
    date: '2026-11-25',
    title: 'Formação de preço',
    changes: [
      'A ficha técnica ganhou o tempo de impressão por peça e a impressora padrão, e mostra o custo da máquina e da energia.',
      'Ao criar uma ordem de produção sem tempo informado, o painel sugere o tempo pela soma das fichas técnicas.',
      'O antigo bloco Estoque e venda do produto virou Formação de preço: mostra insumos, máquina ou custo médio, os custos vinculados, a margem e o preço sugerido.',
      'Os custos cadastrados podem ser vinculados ao produto. Mudar um custo no cadastro atualiza o preço sugerido de todos os produtos que o usam.',
      'O painel avisa quando a margem somada aos custos sobre a venda chega a 100%, porque nenhum preço cobriria isso.',
      'Na compra, cada item mostra o custo unitário e o preço sugerido, e quem opera o estoque pode atualizar o preço de venda ao lançar.',
      'Uma impressora padrão de ficha técnica e um custo vinculado a produtos não podem ser excluídos, apenas inativados.',
      'A planilha de carga inicial ganhou as colunas Tempo por peça, Impressora e Custos vinculados.',
    ],
  },
  {
    version: '0.5.0',
    date: '2026-11-25',
    title: 'Cadastro de custos',
    changes: [
      'Cadastros › Comercial ganhou a aba Custos, para guardar custos como embalagem, frete e impostos.',
      'Cada custo pode ser um valor fixo ou um percentual, e o percentual pode valer sobre o custo ou sobre o preço de venda.',
      'Na compra, os custos adicionais podem ser escolhidos da lista. O título, o tipo e o valor são preenchidos e podem ser ajustados.',
      'A compra guarda os valores do dia, então mudar um custo cadastrado não altera compras já lançadas.',
      'Um custo já usado em compras não pode ser excluído, apenas inativado.',
      'A planilha de carga inicial ganhou a aba Custos.',
    ],
  },
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
