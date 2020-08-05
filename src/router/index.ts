import Vue from "vue";
import Router from "vue-router";
import Wallet from "@/views/Wallet.vue";
import WalletAccount from "@/views/WalletAccount.vue";
import Tokens from "@/views/Tokens.vue";
import Relays from "@/views/Relays.vue";
import Data from "@/views/Data.vue";
import RelayDetail from "@/views/RelayDetail.vue";
import PageNotFound from "@/views/PageNotFound.vue";
import HeroConvert from "@/components/hero/sub/HeroConvert.vue";
import HeroTransfer from "@/components/hero/sub/HeroTransfer.vue";
import HeroRelay from "@/components/hero/sub/HeroRelay.vue";
import HeroCreate from "@/components/hero/sub/HeroCreate.vue";
import Navigation from "@/components/layout/Navigation.vue";
import { services } from "@/api/helpers";
import PoolHome from "@/components/pool/PoolHome.vue";
import PoolActions from "@/components/pool/PoolActions.vue";
import SwapHome from "@/components/swap/SwapHome.vue";

Vue.use(Router);

export const defaultModule = "eth";
const PREFERRED_SERVICE = "preferredService";

export const router = new Router({
  mode: "history",
  base: process.env.BASE_URL,
  //linkExactActiveClass: "active",
  scrollBehavior(to, from, savedPosition) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (savedPosition) {
          resolve(savedPosition);
        } else {
          resolve({ x: 0, y: 0 });
        }
      }, 500);
    });
  },
  routes: [
    {
      path: "/404",
      name: "404",
      components: {
        Nav: Navigation,
        default: PageNotFound
      }
    },
    {
      path: "/:service/create",
      name: "Create",
      components: {
        Nav: Navigation,
        Hero: HeroCreate
      }
    },
    {
      path: "/:service/transfer/:id",
      name: "Transfer",
      components: {
        Nav: Navigation,
        default: WalletAccount,
        Hero: HeroTransfer
      },
      props: true
    },
    {
      path: "/:service/wallet",
      name: "Wallet",
      components: {
        Nav: Navigation,
        default: Wallet
      }
    },
    {
      path: "/:service/wallet/:account",
      name: "WalletAccount",
      components: {
        Nav: Navigation,
        Hero: HeroTransfer,
        default: WalletAccount
      },
      props: true
    },
    {
      path: "/:service/pool",
      name: "Pool",
      components: {
        Nav: Navigation,
        Hero: PoolHome
      },
      props: true,
      meta: {
        feature: "Liquidity"
      }
    },
    {
      path: "/:service/pool/:poolAction/:account",
      name: "PoolAction",
      components: {
        Nav: Navigation,
        Hero: PoolActions
      },
      props: true,
      meta: {
        feature: "Liquidity"
      }
    },
    {
      path: "/:service/pools",
      name: "Relays",
      components: {
        Nav: Navigation,
        Hero: HeroRelay
      },
      props: true,
      meta: {
        feature: "Liquidity"
      }
    },
    {
      path: "/:service/pools/:account/detail",
      name: "RelayDetail",
      components: {
        Nav: Navigation,
        Hero: HeroRelay
      },
      props: true
    },
    {
      path: "/:service/pools/:account",
      name: "Relay",
      components: {
        Nav: Navigation,
        Hero: HeroRelay
      },
      props: true,
      meta: {
        feature: "Liquidity"
      }
    },
    {
      path: "/:service/swap",
      name: "Swap",
      components: {
        Nav: Navigation,
        Hero: SwapHome
      },
      props: true,
      meta: {
        feature: "Trade"
      }
    },
    // {
    //   path: "/:service",
    //   name: "Tokens",
    //   components: {
    //     Nav: Navigation,
    //     Hero: HeroConvert
    //   },
    //   props: true,
    //   meta: {
    //     feature: "Trade"
    //   }
    // },
    {
      path: "/:service/data",
      name: "Data",
      components: {
        Nav: Navigation,
        default: Data
      },
      props: true,
      meta: {
        feature: "Liquidity"
      }
    },
    {
      path: "*",
      redirect: `/${defaultModule}`
    },
    {
      path: "/",
      redirect: () => {
        const preferredService = localStorage.getItem(PREFERRED_SERVICE);
        if (preferredService) {
          const foundService = services.find(
            service => service.namespace == preferredService
          );
          if (foundService) return `/${foundService.namespace}/swap`;
        }
        return `/${defaultModule}/swap`;
      }
    }
  ]
});

const setPreferredService = (service: string) => {
  localStorage.setItem(PREFERRED_SERVICE, service);
};

router.beforeEach((to, from, next) => {
  if (to.meta && to.meta.feature) {
    const service = services.find(
      service => service.namespace == to.params.service
    )!;
    if (!service) {
      next("/404");
      return;
    }
    setPreferredService(service.namespace);
    switch (to.meta.feature) {
      case "Trade":
        if (service.features.includes(0)) next();
        else next("/404");
        break;
      case "Liquidity":
        if (service.features.includes(2)) next();
        else next("/404");
        break;
      default:
        next();
    }
  } else {
    next();
  }
});
