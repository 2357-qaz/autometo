import Capacitor
import UIKit

/// The web view, plus this app's own native plugin (it lives in the app, not in an npm package).
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AutomedoNativePlugin())
    }
}
