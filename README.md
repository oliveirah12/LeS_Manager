# LeS Manager

Painel interno instalável como PWA para catálogo, estoque e consultas ao Inter Empresas. A primeira versão atende uma empresa, um local de estoque e uma conta Inter.

## Executar localmente

Requer Node.js 22.18 ou superior e PostgreSQL. O Docker Compose oferece um banco local de desenvolvimento. Se já tiver PostgreSQL, use uma base vazia e ajuste `DATABASE_URL`.

```powershell
Copy-Item .env.example .env   # preencha CONFIG_ENCRYPTION_KEY com o comando indicado no arquivo
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

A instalação está disponível no **build de produção** em `localhost` ou em um endereço **HTTPS**. Em outro dispositivo, acesse o endereço HTTPS da empresa. Use **Instalar** no aviso do canto inferior ou a opção de instalação do navegador. Depois de dispensado, o aviso não volta neste navegador. No Safari do iPhone, escolha **Compartilhar → Adicionar à Tela de Início**. O app instalado abre em janela própria. As operações precisam de conexão com a API. O cache offline contém somente a página pública de aviso.

Abra o menu da conta, no canto superior direito, para alternar entre os temas claro e escuro, acessar **Minha conta** ou sair. A troca de senha encerra todas as sessões da conta. No computador, o menu lateral pode ser recolhido em uma barra de ícones, e a escolha fica memorizada neste navegador. No celular, a barra inferior leva às áreas principais, e **Mais** abre o menu completo. Quando a sessão expira, o painel volta ao login e, depois de entrar, abre a mesma tela.

Cada tela tem seu próprio endereço, como `/#/estoque` ou `/#/financeiro/conciliacao`. Atualizar a página mantém a tela, os botões voltar e avançar do navegador funcionam, e um link aberto sem sessão leva à tela pedida depois do login. Endereços desconhecidos ou fora do perfil abrem o Início.

**Início** mostra, em blocos separados, o resumo do **Estoque** (produtos, valor pelo custo médio, kits e movimentações) e do **Financeiro** (saldo bancário, entradas, saídas e lançamentos a conciliar), conforme o perfil. Clique no logo para voltar a essa tela. **Catálogo** reúne as consultas de produtos e kits. Para incluir ou editar esses itens, abra **Cadastros → Produtos** ou **Cadastros → Kits** e use os formulários do painel lateral. Itens fora de linha podem ser **inativados**: eles saem do estoque e das listas de seleção, e o histórico é preservado. Um produto só pode ser inativado com saldo zerado e fora de kits ativos. Use o filtro **Inativos** para encontrá-los e reativá-los. Só é possível **excluir** o que nunca entrou no histórico: produto sem movimentação, kit ou inventário confirmado, e kit sem saídas. Um produto com histórico só troca de unidade dentro da mesma família. Em **Cadastros → Tipos de produto**, cada tipo define se o produto é usado como insumo ou é fabricado. Produtos fabricados têm uma **Ficha técnica**, com os insumos de uma unidade e o percentual de perda de material. Em **Produção → Impressoras**, cadastre a potência, o desgaste por hora e a tarifa de energia. Em **Produção → Ordens**, planeje a impressão: ao iniciar, os insumos ficam reservados; ao concluir, o sistema baixa o consumo real, dá entrada nas peças boas e congela o custo. A perda só encarece as peças boas se você escolher essa opção.

Para hospedar o painel, mantenha frontend e API na mesma origem. Configure HTTPS no proxy, `COOKIE_SECURE=true` e um endereço de escuta apropriado em `HOST`. Defina `TRUST_PROXY` com a quantidade de proxies à frente da API, normalmente `1`, para que o app enxergue o endereço real de cada visitante. Use essa opção somente quando o proxy for o único caminho até a porta da API.

O login, o primeiro acesso e a troca de senha aceitam até 20 tentativas por minuto de cada endereço. Cada conta aceita até 10 tentativas sem sucesso em 15 minutos, e uma entrada correta zera essa contagem. Restrinja o acesso ao banco e faça backup da base antes de atualizar versões.

## Produção com Docker

O `Dockerfile` gera uma imagem com a API e o painel, e o `compose.prod.yaml` sobe essa imagem com o PostgreSQL. O banco não fica exposto fora do Docker, e o app escuta em `127.0.0.1:3000` para ficar atrás de um proxy HTTPS, como Caddy ou Nginx.

```powershell
Copy-Item .env.prod.example .env.prod   # defina POSTGRES_PASSWORD e CONFIG_ENCRYPTION_KEY
docker compose -f compose.prod.yaml --env-file .env.prod up -d --build
docker compose -f compose.prod.yaml --env-file .env.prod exec app npm run db:migrate
docker compose -f compose.prod.yaml --env-file .env.prod exec app npm run admin:create:prod -- "Seu nome" admin@empresa.com
```

O contêiner verifica `/api/health`, que confirma a API e o banco. As credenciais do banco não ficam no servidor: elas são configuradas pelo painel, como descrito em **Financeiro e conciliação**.

**Guarde a `CONFIG_ENCRYPTION_KEY` junto do backup do banco.** Ela cifra o Client Secret e a chave privada salvos no painel. Sem ela, um backup restaurado traz todo o resto, mas esses dois ficam ilegíveis, e será preciso enviá-los de novo em **Financeiro → Integração**. Trocar a chave tem o mesmo efeito.

Para atualizar, faça backup da base, rode `git pull`, repita o `up -d --build` e depois o `db:migrate`. As migrações são aplicadas manualmente para que nenhuma alteração no banco aconteça sem um backup antes.

Rode uma única instância da API. Os limites de tentativas de login e a trava da sincronização bancária ficam na memória do processo. Para usar mais de uma instância, mova esse estado para o banco ou para um Redis antes.

## Conferir o primeiro fluxo

1. Em **Cadastros → Famílias de medida**, crie Peças com base `un` e Peso com base `g`. Em **Cadastros → Unidades de medida**, cadastre `kg` com fator `1000`. Somente administradores cadastram famílias e unidades, porque o fator define como todas as quantidades são gravadas. Nome e símbolo podem ser editados a qualquer momento. O fator só muda, e a unidade só pode ser excluída, enquanto nenhum produto da família tiver saldo ou histórico. A unidade base mantém o fator 1 e só sai junto com a família, que pode ser excluída quando não tem produtos.
2. Em **Estoque**, baixe o modelo de carga inicial. Preencha dois SKUs novos, um em `un` e outro em `kg`. A coluna **Custo total** informa quanto vale o saldo da linha, e o sistema calcula o valor por unidade. Tipo, Perda e classificações são opcionais, e a aba **Listas** mostra os valores cadastrados. Para produtos fabricados, a aba **Ficha técnica** recebe o consumo de uma unidade, com insumos da mesma carga ou já cadastrados. Planilhas antigas continuam aceitas, e nelas a coluna Custo segue valendo por unidade.
3. Gere a prévia e confirme. Registre uma saída do item por peso em `g` e confira quantidade, custo por grama e usuário no histórico.
4. Use a contagem em lote ou o segundo modelo XLSX para inventário. Confirme somente depois de conferir as diferenças. Uma movimentação posterior à prévia exige uma nova conferência.

O custo do estoque usa a **média ponderada móvel**. Cada compra ou carga inicial recalcula o custo médio do produto, e as saídas gravam o custo médio vigente no momento. A tela de estoque também mostra o custo da última compra, apenas para consulta. Quando o produto tem saldo sem custo conhecido, como após um ajuste positivo antes da primeira compra, a compra seguinte define o custo de todo o saldo.

## Financeiro e conciliação

Crie uma integração no Inter com permissão de consulta de extrato e baixe o certificado e a chave privada. Depois, um administrador abre **Financeiro → Integração**, escolhe o ambiente, informa o Client ID, o Client Secret e, se houver mais de uma conta, a conta corrente, e envia os dois arquivos PEM. O painel confere se a chave corresponde ao certificado e se ele está dentro da validade. Use **Testar conexão** e depois **Financeiro → Extrato → Sincronizar período**. Comece pelo ambiente Sandbox, que usa dados fictícios. [Portal do Inter Empresas](https://developers.inter.co/sandbox)

O Client Secret e a chave privada são gravados cifrados com a `CONFIG_ENCRYPTION_KEY` e nunca voltam para a tela, nem entram na auditoria. Para trocar só o certificado, envie os arquivos novos e deixe o secret em branco. A tela avisa 30 dias antes do vencimento do certificado. Somente administradores veem e alteram a integração.

A atualização consulta todas as páginas antes de gravar. Cada dia completo substitui a versão anterior daquele dia em uma transação única. Se o banco falhar durante a consulta, o painel mantém o último saldo e extrato gravados.

O Inter é o provedor disponível nesta versão. Para integrar outro banco, implemente o contrato `BankReader` e registre o adaptador em `api/finance/providers.ts`. Saldo, extrato e conciliações são separados por provedor. Em **Financeiro → Conciliação**, um operador pode conferir um lançamento e informar uma referência interna opcional. Lançamentos sem identificador único ficam disponíveis para consulta. As reimportações preservam a conferência dos lançamentos identificados.

## Auditoria

O menu **Auditoria** está disponível a administradores. Ele registra inclusões, alterações, movimentações de estoque, sincronização e conciliação bancária, além dos eventos de segurança: entradas, falhas de login, ativações, trocas de senha, códigos gerados e tentativas negadas de alteração por usuários conectados. Consultas e prévias não são registradas, nem chamadas sem sessão válida, excesso de tentativas ou pedidos vindos de outros sites, que são recusados antes do registro. Cada evento mostra o usuário, o resultado e os valores antes e depois dos campos alterados. Filtre por usuário, ação, resultado e período. Senhas, códigos de acesso e tokens ficam fora do histórico.

Os eventos com mais de 12 meses são removidos automaticamente. Para mudar o prazo, defina `AUDIT_RETENTION_DAYS`.

Prévias de inventário e de carga inicial que não forem confirmadas em 7 dias são removidas automaticamente. As confirmadas ficam guardadas como histórico.

## Testes

O GitHub Actions (`.github/workflows/ci.yml`) roda o build, as migrações e todos os testes, incluindo os HTTP, em um PostgreSQL temporário a cada push em `main` ou `develop` e em cada pull request.

`npm test` executa os testes do adaptador bancário. Para rodar também os testes HTTP, use uma **base exclusiva de testes**, já migrada, e configure `TEST_DATABASE_URL`. Os testes criam registros nessa base. Nunca use o banco da empresa para executar a suíte.
