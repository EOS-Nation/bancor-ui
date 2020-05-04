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

@Module({ namespacedPath: "eosWallet/" })
export class EosTransitModule extends VuexModule {
  @getter accessContext = initAccessContext({
    appName: "XNation",
    network: {
      host: "eos.greymass.com",
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
      keycat()
    ]
  });

  @getter
  walletProviders: WalletProvider[] = this.accessContext.getWalletProviders();

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
      throw new Error(e.message);
    }
  }

  @action async initLogin(provider: WalletProvider) {
    this.setProvider(provider);

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
