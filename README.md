# Full Radar — Monitor de coletas

Extensão MV3 para Chrome que acompanha, em abas escolhidas pelo vendedor, a página de agendamento do Mercado Livre. A extensão roda localmente no navegador: não coleta credenciais e não envia conteúdo da conta para um servidor.

## Recursos desta primeira versão

- Datas específicas em ordem de preferência ou um período.
- Verificação entre 30 segundos e 5 minutos.
- Reabre o seletor de datas depois de cada recarga da página e aguarda o calendário ser renderizado.
- Pode guardar o ID de um envio e, ao detectar a tela de erro do Mercado Livre, tenta retomar esse mesmo envio pela Gestão de envios Full e pela edição da coleta.
- Se a recuperação pausar, o popup informa o motivo e permite retomá-la quando a aba voltar a uma etapa reconhecida.
- Monitoramento de várias abas do Mercado Livre.
- Contador com a frequência configurada, tempo estimado até o próximo refresh e tempo desde a última solicitação de atualização. O Chrome pode atrasar alarmes enquanto o computador estiver suspenso.
- Seleção da data disponível e confirmação em duas etapas: confirma a data no calendário e, depois, confirma a coleta no resumo que mostra a data e o custo.
- Notificação do Chrome quando seleciona uma data, confirma a coleta ou precisa que você confira a página.
- Histórico local dos erros mais recentes (até 200), acessível no popup e exportável em JSON. IDs de envio e e-mails são removidos dos registros.
- Interrupção por aba, em todas as abas, ou quando a aba é fechada.

## Instalar para desenvolvimento

1. Abra `chrome://extensions` no Chrome.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e escolha esta pasta.
4. Entre normalmente no Mercado Livre e abra a página de agendamento do Full.
5. Abra o popup, informe as datas e inicie a busca.

Se a página já estava aberta quando você carregou a extensão, atualize essa aba para o Chrome injetar o monitor.

## Limites conhecidos

O fluxo de coleta mostrado nas capturas tem dois passos de confirmação. A extensão tenta identificar o mês e os dias do calendário, confirma a seleção da data e só clica no segundo botão quando reconhece o resumo da coleta com a data e o custo. Ela só informa sucesso quando a página apresenta um texto de confirmação conhecido. Para recuperação após erro, informe o ID do envio no popup e inicie a busca naquela aba; IDs específicos não são aplicados ao botão de várias abas. A extensão só prossegue quando encontra uma única linha com o ID e uma única ação correspondente. Se o Mercado Livre mudar os rótulos ou a estrutura da página, ela pausa e avisa em vez de escolher outro envio. O calendário e as páginas de gestão são autenticados e podem mudar por conta, região ou atualização do site.

Esta versão ainda não implementa a escolha de centro de distribuição/faixa de horário para veículo particular, login/licença por e-mail, alertas por e-mail ou sincronização entre computadores. Ela evita selecionar a mesma data ou uma data de menor prioridade quando já vê uma data desejada no controle da página; identificar com segurança uma reserva existente depende de como ela aparece na conta real. Os recursos de servidor exigiriam um backend próprio.

## Privacidade

As permissões de abas e notificações são usadas para atualizar apenas páginas do Mercado Livre abertas pelo usuário, listar buscas ativas e mostrar avisos locais. O histórico de erros fica no armazenamento local do Chrome e só sai do navegador se você baixar e compartilhar o arquivo exportado. A extensão não solicita senha, não lê páginas fora dos domínios configurados e não usa serviços remotos.
