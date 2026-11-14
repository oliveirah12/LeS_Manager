# LeS Manager

Painel interno instalável como PWA para catálogo, estoque e consultas ao Inter Empresas. A primeira versão atende uma empresa, um local de estoque e uma conta Inter.

## Executar localmente

Requer Node.js 22.18 ou superior e PostgreSQL. O Docker Compose oferece um banco local de desenvolvimento. Se já tiver PostgreSQL, use uma base vazia e ajuste `DATABASE_URL`.

```powershell
Copy-Item .env.example .env
docker compose up -d
npm ci
npm run db:generate
npm run db:migrate
npm run admin:create -- "Seu nome" admin@empresa.com
npm run build
npm start
```

Abra http://localhost:3000, selecione **Primeiro acesso** e use o e-mail e o código exibidos pelo comando. O código é de uso único, vence em 24 horas e pode ser regenerado com o mesmo comando enquanto a conta inicial aguarda ativação. A senha exige pelo menos 8 caracteres, incluindo uma letra e um número. Em **Acessos**, crie perfis e usuários e entregue os códigos diretamente à equipe.

Para desenvolvimento com recarregamento automático, execute `npm run dev:api` e `npm run dev:web` em terminais separados. Use a porta 3000 para a API e abra o endereço mostrado pelo Vite.

## Instalar o aplicativo

A instalação está disponível no **build de produção** em `localhost` ou em um endereço **HTTPS**. Em outro dispositivo, acesse o endereço HTTPS da empresa. Use **Instalar aplicativo** no aviso do canto inferior direito ou a opção de instalação do navegador. Ao dispensar o aviso, o botão discreto **Instalar app** permanece disponível enquanto o app estiver disponível para instalação. No Safari do iPhone, escolha **Compartilhar → Adicionar à Tela de Início**. O app instalado abre em janela própria. As operações precisam de conexão com a API. O cache offline contém somente a página pública de aviso.

Abra o menu da conta no cabeçalho para alternar entre os temas claro e escuro ou acessar as configurações pessoais. Administradores também encontram **Minha conta** no menu **Acessos**. A troca de senha encerra todas as sessões da conta. O menu lateral memoriza se está aberto ou fechado neste navegador.

**Início** mostra os atalhos autorizados pelo perfil. Clique no logo para voltar a essa tela. **Catálogo** reúne as consultas de produtos e kits. Para incluir ou editar esses itens, abra **Cadastros → Produtos** ou **Cadastros → Kits** e use os formulários em modal.

Para hospedar o painel, mantenha frontend e API na mesma origem. Configure HTTPS no proxy, `COOKIE_SECURE=true` e um endereço de escuta apropriado em `HOST`. Restrinja o acesso ao banco e faça backup da base antes de atualizar versões.

## Conferir o primeiro fluxo

1. Em **Cadastros → Famílias de medida**, crie Peças com base `un` e Peso com base `g`. Em **Cadastros → Unidades de medida**, cadastre `kg` com fator `1000`.
2. Em **Estoque**, baixe o modelo de carga inicial. Preencha dois SKUs novos, um em `un` e outro em `kg`. A coluna Custo informa o valor por unidade declarada na mesma linha. Classificações são opcionais e devem existir no catálogo quando preenchidas.
3. Gere a prévia e confirme. Registre uma saída do item por peso em `g` e confira quantidade, custo por grama e usuário no histórico.
4. Use a contagem em lote ou o segundo modelo XLSX para inventário. Confirme somente depois de conferir as diferenças. Uma movimentação posterior à prévia exige uma nova conferência.

O custo do estoque usa a **média ponderada móvel**. Cada compra ou carga inicial recalcula o custo médio do produto, e as saídas gravam o custo médio vigente no momento. A tela de estoque também mostra o custo da última compra, apenas para consulta.

## Financeiro e conciliação

Crie uma integração no Inter com permissão de consulta de extrato. Comece com `INTER_ENV=sandbox` e preencha as variáveis comentadas em `.env.example`. Aponte para os arquivos PEM do certificado e da chave privada fora do repositório. `INTER_ACCOUNT` é opcional quando a integração identifica uma única conta. Reinicie a API e use **Financeiro → Extrato → Atualizar saldo e extrato do período**. O sandbox usa dados fictícios. [Portal do Inter Empresas](https://developers.inter.co/sandbox)

A atualização consulta todas as páginas antes de gravar. Cada dia completo substitui a versão anterior daquele dia em uma transação única. Se o banco falhar durante a consulta, o painel mantém o último saldo e extrato gravados.

O Inter é o provedor disponível nesta versão. Para integrar outro banco, implemente o contrato `BankReader` e registre o adaptador em `api/finance/providers.ts`. Saldo, extrato e conciliações são separados por provedor. Em **Financeiro → Conciliação**, um operador pode conferir um lançamento e informar uma referência interna opcional. Lançamentos sem identificador único ficam disponíveis para consulta. As reimportações preservam a conferência dos lançamentos identificados.

## Auditoria

O menu **Auditoria** está disponível a administradores. Ele registra inclusões, alterações, movimentações de estoque, sincronização e conciliação bancária, além dos eventos de segurança: entradas, falhas de login, ativações, trocas de senha, códigos gerados e tentativas negadas de alteração. Consultas e prévias não são registradas. Cada evento mostra o usuário, o resultado e os valores antes e depois dos campos alterados. Filtre por usuário, ação, resultado e período. Senhas, códigos de acesso e tokens ficam fora do histórico.

Os eventos com mais de 12 meses são removidos automaticamente. Para mudar o prazo, defina `AUDIT_RETENTION_DAYS`.

## Testes

`npm test` executa os testes do adaptador bancário. Para rodar também os testes HTTP, use uma **base exclusiva de testes**, já migrada, e configure `TEST_DATABASE_URL`. Os testes criam registros nessa base. Nunca use o banco da empresa para executar a suíte.
