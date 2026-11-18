import SwiftUI
import UIKit
import WebKit

/// Abre o Pluggy Connect numa WebView. O usuário digita a senha do banco na
/// página do Pluggy; o app nunca vê essa senha, só recebe o id da conexão.
struct PluggyConnectView: UIViewRepresentable {
    static let handlerName = "pluggyConnectHandler"

    let url: URL
    let onEvent: (PluggyConnectEvent) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onEvent: onEvent) }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(WeakMessageHandler(context.coordinator), name: Self.handlerName)
        // A página procura o objeto que o SDK de React Native cria; aqui ele
        // repassa as mensagens para o app.
        let bridge = """
        window.ReactNativeWebView = { postMessage: function(m) { window.webkit.messageHandlers.\(Self.handlerName).postMessage(m); } };
        """
        controller.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        // Nada da sessão do banco (cookies, armazenamento) fica guardado no aparelho.
        config.websiteDataStore = .nonPersistent()

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: handlerName)
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        private let onEvent: (PluggyConnectEvent) -> Void
        private var parser = PluggyConnect.LocationParser()

        init(onEvent: @escaping (PluggyConnectEvent) -> Void) { self.onEvent = onEvent }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let msg = PluggyConnect.BridgeMessage.decode(message.body) else { return }
            switch msg.type {
            case "OAUTH_OPEN", "LINK_OPEN":
                // Login por OAuth abre o app ou o site do banco, fora da WebView.
                Self.openExternally(msg.message)
            case "LOCATION":
                if let event = parser.parse(msg.message) { onEvent(event) }
            default:
                break
            }
        }

        /// Só endereços https navegam dentro da WebView. Janelas novas (como
        /// as do OAuth) abrem fora, no Safari ou no app do banco.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = navigationAction.request.url else { return .cancel }
            if navigationAction.targetFrame == nil {
                Self.openExternally(url.absoluteString)
                return .cancel
            }
            return url.scheme == "https" || url.scheme == "about" ? .allow : .cancel
        }

        private static func openExternally(_ text: String) {
            guard let url = URL(string: text), url.scheme == "https" else { return }
            UIApplication.shared.open(url)
        }
    }
}

/// O WKUserContentController segura o handler com referência forte. Esta
/// casca segura o coordenador com referência fraca, para a tela ser liberada.
@MainActor
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
