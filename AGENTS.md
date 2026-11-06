# LeS Manager

- Preserve a arquitetura de monólito modular. Controllers validam a entrada e aplicam permissões, serviços contêm regras do negócio e o adaptador Inter encapsula autenticação e transporte.
- Prefira mudanças pequenas e código direto. Aplique SOLID e Clean Architecture onde melhorarem a leitura e os testes.
- Banco, planilhas e API usam decimais exatos. Normalize quantidades na unidade base e congele o custo da saída no histórico.
- Movimentações, kits e lotes de planilha são atômicos. Preserve a revisão de estoque e nunca permita saldo negativo.
- Autorize cada rota no backend. Mantenha o código de primeiro acesso temporário e de uso único. Nunca registre senhas, códigos, tokens ou certificados.
- O service worker guarda somente a página pública de contingência. Mantenha dados do painel e respostas da API fora do cache.
- Execute `npm run build` e `npm test`. Para os testes HTTP, aponte `TEST_DATABASE_URL` a uma base exclusiva de testes e aplique as migrações nela.
- Use `les_architecture_reviewer` para fronteiras, SOLID e legibilidade e `les_quality_reviewer` para testes, acessos e integridade. Ambos revisam sem alterar arquivos.
