import Foundation

/// Dinheiro sempre em centavos inteiros, como no backend. Nunca Double:
/// 0,1 + 0,2 em ponto flutuante não dá 0,3, e em dinheiro isso vira erro de centavo.
typealias Cents = Int

enum Money {
    /// "R$ 1.234,56". Montado à mão para não depender do formato do aparelho:
    /// o app é só em reais (RNF17), mesmo num iPhone configurado em inglês.
    static func format(_ cents: Cents) -> String {
        let sign = cents < 0 ? "-" : ""
        let abs = Swift.abs(cents)
        let reais = String(abs / 100)
        var grouped = ""
        for (i, ch) in reais.reversed().enumerated() {
            if i > 0 && i % 3 == 0 { grouped.append(".") }
            grouped.append(ch)
        }
        let centavos = abs % 100
        return "\(sign)R$ \(String(grouped.reversed())),\(centavos < 10 ? "0" : "")\(centavos)"
    }

    /// Pontos-base para texto, arredondado para um número inteiro: 4235 vira "42%".
    /// Na tela, a fatia do gráfico não precisa de centavo de percentual.
    static func percent(basisPoints: Int) -> String {
        "\((basisPoints + 50) / 100)%"
    }
}
