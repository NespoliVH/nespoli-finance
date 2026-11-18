# App iOS (Swift e SwiftUI)

App nativo para iOS 17 ou superior, no padrão MVVM com repositórios (etapa 2).

## Como compilar

Não é preciso Mac: o GitHub Actions compila e roda os testes num Mac a cada
pull request que mexe em `ios/` (`.github/workflows/ios.yml`). Quem tiver Mac
pode gerar o projeto localmente:

```sh
brew install xcodegen
cd ios && xcodegen generate && open NespoliFinance.xcodeproj
```

O `.xcodeproj` não fica no Git; ele é gerado a partir do `project.yml`.

## Modo demonstração

Sem endereço do backend ou sem sessão salva (o login com a Apple chega no
módulo 3), o app abre com dados de exemplo. As regras de gasto e de correção
de categoria são as mesmas do backend.

## Estrutura

| Pasta | O que tem |
| --- | --- |
| `NespoliFinance/App` | Entrada do app, abas e escolha entre modo real e demonstração |
| `NespoliFinance/Core` | Valores em reais, modelos, cliente da API com ETag e cópia offline, Keychain |
| `NespoliFinance/Data` | Repositórios: backend real e modo demonstração |
| `NespoliFinance/Features` | Telas (View) e seus ViewModels, uma pasta por funcionalidade |
| `NespoliFinanceTests` | Testes de unidade |
