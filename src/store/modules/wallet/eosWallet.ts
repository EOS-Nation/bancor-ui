import {
  VuexModule,
  mutation,
  action,
  getter,
  Module
} from "vuex-class-component";
import {
  initAccessContext,
  WalletProvider,
  Wallet,
  WalletState
} from "eos-transit";
import scatter from "eos-transit-scatter-provider";
import lynx from "eos-transit-lynx-provider";
import ledger from "eos-transit-ledger-provider";
import tp from "eos-transit-tokenpocket-provider";
import meetone from "eos-transit-meetone-provider";
import whalevault from "eos-transit-whalevault-provider";
import keycat from "eos-transit-keycat-provider";
import anchor from "eos-transit-anchorlink-provider";
import LogRocket from "logrocket";

interface EosWalletAction {
  name: string;
  data: any;
  authorization?: {
    actor: string;
    permission: string;
  }[];
  account: string;
}

const appName = "XNation";

const mobileCompatibleWallets = [
  "EOS Lynx",
  "TokenPocket",
  "meetone_provider",
  "whalevault",
  "Keycat",
  "anchor-link"
];

const isMobileCompatible = (mobileCompatibleIds: string[]) => (
  provider: WalletProvider
): boolean => mobileCompatibleIds.some(id => provider.id == id);

@Module({ namespacedPath: "eosWallet/" })
export class EosTransitModule extends VuexModule {
  @getter accessContext = initAccessContext({
    appName,
    network: {
      host: "nodes.get-scatter.com",
      port: 443,
      protocol: "https",
      chainId:
        "aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906"
    },
    walletProviders: [
      scatter(),
      lynx(),
      ledger(),
      tp(),
      meetone(),
      whalevault(),
      keycat(),
      anchor(appName)
    ]
  });
  isMobile = false;

  @getter
  providers: WalletProvider[] = this.accessContext.getWalletProviders();

  get walletProviders() {
    return this.isMobile
      ? this.providers.filter(isMobileCompatible(mobileCompatibleWallets))
      : this.providers;
  }

  selectedProvider: WalletProvider | "" = "";

  wallet: Wallet | false = false;
  walletState: WalletState | false = false;

  get loginStatus() {
    const login = ["Login", "arrow-circle-right", false];
    if (!this.wallet && !this.walletState) return login;
    else if (this.walletState && this.walletState.authenticating)
      return ["Authenticating", "spinner", true];
    else if (this.walletState && this.walletState.connecting)
      return ["Connecting", "spinner", true];
    else if (this.walletState && this.walletState.accountFetching)
      return ["Fetching", "spinner", true];
    else if (this.wallet && this.wallet.auth) {
      return [this.wallet.auth.accountName, "power-off", false];
    } else return login;
  }

  get isAuthenticated(): string | false {
    // @ts-ignore
    return this.wallet && this.wallet.auth && this.wallet.auth.accountName;
  }

  @action async checkDevice() {
    const userAgent = window.navigator.userAgent;
    const isIOS = userAgent.includes("iPhone") || userAgent.includes("iPad");
    const isMobile = userAgent.includes("Mobile");
    const isAndroid = userAgent.includes("Android");
    const isCustom = userAgent.toLowerCase().includes("eoslynx");

    this.setIsMobile(isIOS || isMobile || isAndroid || isCustom);
  }

  @mutation setIsMobile(isMobile: boolean) {
    this.isMobile = true;
  }

  @action async tx(actions: EosWalletAction[]) {
    const authIncluded = actions.every(
      (action: EosWalletAction) => action.authorization
    );

    const builtActions = authIncluded
      ? actions
      : actions.map((action: any) => ({
          ...action,
          authorization: [
            {
              // @ts-ignore
              actor: this.wallet.auth.accountName,
              // @ts-ignore
              permission: this.wallet.auth.permission
            }
          ]
        }));
    console.log("tx ran", LogRocket, "should have been logrocket");
    try {
      // @ts-ignore
      return await this.wallet.eosApi.transact(
        {
          actions: builtActions
        },
        {
          broadcast: true,
          blocksBehind: 3,
          expireSeconds: 60
        }
      );
    } catch (e) {
      console.log("log rocket should be taking care of this...", LogRocket);

      LogRocket.captureException(e, {
        extra: {
          // @ts-ignore
          account: this.wallet.auth.accountName,
          actions: JSON.stringify(builtActions.map(action => action.data))
        }
      });
      // @ts-ignore
      LogRocket.captureMessage(`FailedTx${this.wallet.auth.accountName}`);
      if (e.message == "Unexpected end of JSON input")
        // @ts-ignore
        return await this.wallet.eosApi.transact(
          {
            actions: builtActions
          },
          {
            broadcast: true,
            blocksBehind: 3,
            expireSeconds: 60
          }
        );
      throw new Error(e.message);
    }
  }

  @action async initLogin(provider: WalletProvider) {
    this.setProvider(provider);
    this.checkDevice();

    const wallet = this.accessContext.initWallet(provider);

    wallet.subscribe((walletState: any) => {
      if (walletState) this.setWalletState(walletState);
    });

    try {
      await wallet.connect();

      try {
        await wallet.login();
        this.setWallet(wallet);
        localStorage.setItem("autoLogin", provider.id);
      } catch (e) {
        console.log("auth error");
        throw e;
      }
    } catch (e) {
      console.log("connection error");
      throw e;
    }
  }

  @action async logout() {
    if (this.wallet) {
      this.wallet.logout();
      this.setWallet(false);
      this.setWalletState(false);
      localStorage.removeItem("autoLogin");
    }
  }

  @mutation setProvider(provider: WalletProvider) {
    this.selectedProvider = provider;
  }

  @mutation setWallet(wallet: Wallet | false) {
    this.wallet = wallet;
  }

  @mutation setWalletState(state: WalletState | false) {
    this.walletState = state;
  }
}
export const eosWallet = EosTransitModule.ExtractVuexModule(EosTransitModule);
