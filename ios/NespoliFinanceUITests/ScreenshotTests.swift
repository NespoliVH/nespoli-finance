import XCTest

/// Percorre as telas no modo demonstração e guarda uma captura de cada uma.
/// Roda no fluxo "Capturas de tela" do GitHub Actions; as imagens vão para o
/// texto do TCC. Se uma tela mudar e um botão sumir, o teste pula a captura
/// em vez de falhar, porque o objetivo aqui são as imagens.
final class ScreenshotTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(pt-BR)", "-AppleLocale", "pt_BR"]
        app.launch()
    }

    func testCapturaTodasAsTelas() {
        wait(app.navigationBars["Resumo"])
        shot("01-resumo")

        tab("Transações")
        wait(app.navigationBars["Transações"])
        shot("02-transacoes")
        // Toca numa compra para abrir a troca de categoria.
        let purchase = app.buttons.matching(NSPredicate(format: "label CONTAINS 'NETFLIX'")).firstMatch
        if purchase.waitForExistence(timeout: 5) {
            purchase.tap()
            if app.navigationBars["Trocar categoria"].waitForExistence(timeout: 5) {
                shot("03-trocar-categoria")
                tapIfExists(app.buttons["Cancelar"])
            }
        }

        tab("Alertas")
        wait(app.navigationBars["Alertas"])
        shot("04-alertas")

        tab("IR")
        wait(app.navigationBars["Imposto de Renda"])
        sleep(1)
        shot("05-imposto-de-renda")
        if tapIfExists(app.buttons["Editar perfil"]) {
            wait(app.navigationBars["Perfil fiscal"])
            shot("06-perfil-fiscal")
            tapIfExists(app.buttons["Cancelar"])
        }

        tab("Ajustes")
        wait(app.navigationBars["Ajustes"])
        shot("07-ajustes")

        if tapIfExists(app.buttons["Bancos conectados"]) {
            wait(app.navigationBars["Bancos conectados"])
            sleep(1)
            shot("08-bancos-conectados")
            if tapIfExists(app.navigationBars.buttons["Conectar banco"]) {
                wait(app.navigationBars["Conectar banco"])
                shot("09-consentimento-banco")
                tapIfExists(app.buttons["Cancelar"])
            }
            back()
        }

        if tapIfExists(app.buttons["Consentimentos"]) {
            wait(app.navigationBars["Consentimentos"])
            shot("10-consentimentos")
            back()
        }

        if tapIfExists(app.buttons["Excluir minha conta"]) {
            wait(app.navigationBars["Excluir conta"])
            shot("11-excluir-conta")
            tapIfExists(app.buttons["Cancelar"])
        }
    }

    // MARK: Ajudantes

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func tab(_ name: String) {
        tapIfExists(app.tabBars.buttons[name])
    }

    private func back() {
        tapIfExists(app.navigationBars.buttons.element(boundBy: 0))
    }

    @discardableResult
    private func wait(_ element: XCUIElement) -> Bool {
        element.waitForExistence(timeout: 8)
    }

    @discardableResult
    private func tapIfExists(_ element: XCUIElement) -> Bool {
        guard element.waitForExistence(timeout: 5) else { return false }
        element.tap()
        return true
    }
}
