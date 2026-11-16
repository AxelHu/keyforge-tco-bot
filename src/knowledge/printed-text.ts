/** 默认卡牌库实际使用的第三方游戏文字，来自项目既有数据。
 * 这些内容不是本项目自写摘要；本项目 MIT 许可不对其另授许可。
 * 精确来源见 PRINTED_TEXT_PROVENANCE 与项目 NOTICE；只保留实际使用条目。
 */
export const PRINTED_TEXT_PROVENANCE = {
  "toc": {
    "sourceRepository": "https://github.com/keyteki/keyteki",
    "sourceCommit": "361c085bcd401c20976ee9bcc4e4e5b8c061d56c",
    "upstreamPackPath": "master-vault-data/packs/ToC.json",
    "upstreamPackUrl": "https://raw.githubusercontent.com/keyteki/keyteki/361c085bcd401c20976ee9bcc4e4e5b8c061d56c/master-vault-data/packs/ToC.json",
    "upstreamPackSha256": "c7c847f1204d4b5dcc7796d4e55ef10161d927b8c52ef225bac634d035fb9010",
    "originalProjectSnapshot": "data/sets/toc-source-facts.json",
    "originalProjectTable": "src/core/cards/toc-facts.ts#TOC_CARD_TEXT",
    "transformation": "source text.trim(); canonical token prefix is separate from original sourceId"
  },
  "woe-token": {
    "sourceRepository": "https://github.com/keyteki/keyteki",
    "sourceCommit": "361c085bcd401c20976ee9bcc4e4e5b8c061d56c",
    "upstreamPackPath": "master-vault-data/packs/WoE.json",
    "upstreamPackUrl": "https://raw.githubusercontent.com/keyteki/keyteki/361c085bcd401c20976ee9bcc4e4e5b8c061d56c/master-vault-data/packs/WoE.json",
    "upstreamPackSha256": "2e9c981d05cbc3c47bd9dfda232cf043f3c7fc4c781cc8659966552dc95b7e9d",
    "originalProjectSnapshot": "data/sets/woe-source-facts.json",
    "originalProjectTable": "src/core/cards/woe-facts.ts#WOE_TOKEN_TEXT",
    "transformation": "existing nonempty source text; three authored empty-rule fallbacks remain in builtin data"
  }
} as const;
export const PRINTED_TEXT_BY_DEFINITION: Readonly<Record<string, { readonly source: 'toc' | 'woe-token'; readonly sourceId: string; readonly text: string; readonly textSha256: string }>> = {
  "beyond-all-darkness": {
    "source": "toc",
    "sourceId": "beyond-all-darkness",
    "text": "Play: For the remainder of the turn, after a creature is destroyed, make a token creature.",
    "textSha256": "fa0dea0607dad9387a998e1f2c3ce46dce3050f470b957e25152c4bcc64e98b2"
  },
  "the-amasser": {
    "source": "toc",
    "sourceId": "the-amasser",
    "text": "Each time your opponent draws a card, make a token creature on your right flank.",
    "textSha256": "2d4b1ffb927cf87cd60731e0b96bc53104e94676735e79b84ace15d2ad515999"
  },
  "levy-of-souls": {
    "source": "toc",
    "sourceId": "levy-of-souls",
    "text": "Action: Make a token creature. Keys cost +1 for each friendly token creature in play during your opponent's next turn.",
    "textSha256": "4ab2864537ae0bd5361ca1c749e6d721a512434d0c7e521ce8d6bd2c0b5716c4"
  },
  "unbinding": {
    "source": "toc",
    "sourceId": "unbinding",
    "text": "Play: Make a token creature. If a friendly creature was destroyed this turn, archive Unbinding.",
    "textSha256": "13fa78e4fca4bec259d64696996bd7289c04dbd9575269023d88be464e556e66"
  },
  "beta-forge": {
    "source": "toc",
    "sourceId": "beta-forge",
    "text": "Action: Make an Alpha-Gamma. You may forge a key at +12 current cost, reduced by 1 for each card in your archives. If you forge a key this way, purge Beta-Forge.",
    "textSha256": "bfd3d8153ebf3843f155e38d033eaddf35e976fa7e58b0fc6509cfe88e7fd718"
  },
  "cognitive-assumptions": {
    "source": "toc",
    "sourceId": "cognitive-assumptions",
    "text": "Play: Reveal up to 3 Logos cards from your hand. For each card revealed this way, make a token creature.",
    "textSha256": "6235ba9b2246bfd8c5a0751ca8193985c972d218d2522a045b803b8ea28bb95a"
  },
  "auto-autopsy-21": {
    "source": "toc",
    "sourceId": "auto-autopsy-21",
    "text": "Play: Make a token creature.\nOmni: Destroy a friendly creature. If you do, gain 1.",
    "textSha256": "68a90fc217ffc0f50cc68222b5dcd09e602abbc38c325c8985a7813d4bf8017c"
  },
  "administrator-rivet": {
    "source": "toc",
    "sourceId": "administrator-rivet",
    "text": "Play: Make a token creature. If you are haunted, each friendly token creature captures 1.",
    "textSha256": "1b9f8a66c3b714399123d672b3a6a45242bcbf6f15cc7dc104474432656822c0"
  },
  "bump-in-the-night": {
    "source": "toc",
    "sourceId": "bump-in-the-night",
    "text": "Play: Deal 2 to an enemy creature. If this damage destroys that creature, make a token creature. If you are haunted, repeat the preceding effect.",
    "textSha256": "8a725943f93a04ad33bce68bd676203229c971643e42b0f215bbb47c775ac574"
  },
  "sidekick": {
    "source": "toc",
    "sourceId": "sidekick",
    "text": "Play: Choose a card in your hand and put it into play as a token creature.",
    "textSha256": "9e0fa2cb3b8d701ae5190ddfee5bd17410cba21d32410db534f6af907c671538"
  },
  "intrepid-exemplar": {
    "source": "toc",
    "sourceId": "intrepid-exemplar",
    "text": "Taunt.\nAfter Fight/Destroyed: Make a token creature.",
    "textSha256": "45d1c00f15ed74452567afbf655d026fc4076e3bb9043133d789b0501ec15a27"
  },
  "hunter-of-legend": {
    "source": "toc",
    "sourceId": "hunter-of-legend",
    "text": "This creature gains skirmish and “After Fight: Make a token creature.”",
    "textSha256": "34e88d27a68c96987589e94e25709aecc588242f1f1f2e27d2e418937a365477"
  },
  "redhawk": {
    "source": "toc",
    "sourceId": "redhawk",
    "text": "Action: Each player gains 1. Make a token creature.",
    "textSha256": "c63978226e4390003e90bb7afffed50f6599d40c85d7fbb630bc9ae07359cb07"
  },
  "watched-closely": {
    "source": "toc",
    "sourceId": "watched-closely",
    "text": "This creature gains, “After Reap: Your opponent makes a token creature.”",
    "textSha256": "aa4407b4049df9776fddf7d78caa949a43e635180015e8d9ff996fad8ebe22db"
  },
  "fierce-competition": {
    "source": "toc",
    "sourceId": "fierce-competition",
    "text": "Play: Make a token creature. If you and your opponent have the same number of forged keys, archive Fierce Competition.",
    "textSha256": "8a75992e3cd4a2c9381f8f3cebe313b36e2f9f4cfcc8b7715b98e81a8ba5d309"
  },
  "shikari": {
    "source": "toc",
    "sourceId": "shikari",
    "text": "Play: Make a token creature.\nAfter Fight: Return Shikari to your hand.",
    "textSha256": "dbf9b48ffb0b3cd47db95aab0a41fdacbad0ecbf320b29d60d9bb5a0143ba117"
  },
  "the-twin-lamps": {
    "source": "toc",
    "sourceId": "the-twin-lamps",
    "text": "Play: Steal 1. If you have more  in your pool than your opponent, make a token creature.",
    "textSha256": "5b09db5728b3d1bf187ad2856c0c2009f446e3da78a78d4226fbccb0db2f0ca8"
  },
  "the-forsaken": {
    "source": "toc",
    "sourceId": "the-forsaken",
    "text": "Each time your opponent discards a card from their hand, make a token creature on your left flank.",
    "textSha256": "9950e8f503c9b70283ded78afa93d4bdfef777996efda6fea1dabd47983f8e70"
  },
  "gate-warden": {
    "source": "toc",
    "sourceId": "gate-warden",
    "text": "While you control a token creature, enemy creatures cannot reap.\nPlay: Make a token creature.",
    "textSha256": "bb5461e65ce4d35f809acd7e958abfca10f2cf8a708a2944aa5b8df02f8a6854"
  },
  "havoc": {
    "source": "toc",
    "sourceId": "havoc",
    "text": "Enhance .\nPlay: Make a token creature.",
    "textSha256": "f195eb6aab65e1f25589e86872c980b0d6956490f79b49cf873c26f9179e9cc4"
  },
  "looping-dirge": {
    "source": "toc",
    "sourceId": "looping-dirge",
    "text": "Enhance .\nPlay: If you are haunted, make a token creature.",
    "textSha256": "79b2001ca9721d5b6aebd2bbeabdcc5d6e89f514b97364f1b3363eb969858735"
  },
  "dr-westing": {
    "source": "toc",
    "sourceId": "dr-westing",
    "text": "After Reap: If Dr. Westing is on a flank, make a token creature.",
    "textSha256": "8e24905bd493fbcee8bd1fe0ec83c65c24f82bc126cc068ffb5c33d86b2987a8"
  },
  "golis-artificer": {
    "source": "toc",
    "sourceId": "golis-artificer",
    "text": "Enhance .\nAfter Reap: Make a token creature.",
    "textSha256": "8e09b222b18453a574ccd12c5ddeb17002116171bc110ebcc77dc9fdd55a1202"
  },
  "hypothesize": {
    "source": "toc",
    "sourceId": "hypothesize",
    "text": "Play: Make a token creature. If there are three or more friendly Logos cards in play, archive Hypothesize.",
    "textSha256": "e64aaa0ac7f2f83fe8637693bd312f1080e573cb640bfd7045c7d16810ae89e2"
  },
  "sacred-duty": {
    "source": "toc",
    "sourceId": "sacred-duty",
    "text": "This creature gets +2 power and gains, “After Fight: Make a token creature.”\nPlay: Ready this creature.",
    "textSha256": "7f19051f092ed8a733aab6f17ac98f574b7a0ee6cac27ed585538dabbd0a7fe1"
  },
  "admirable-neophyte": {
    "source": "toc",
    "sourceId": "admirable-neophyte",
    "text": "Enhance .\nPlay: Make a token creature.",
    "textSha256": "f49d73046a5954008cd457d5ee28bac71b790718dcac9ce65f8bd3fb12a6043a"
  },
  "steadfast-commitment": {
    "source": "toc",
    "sourceId": "steadfast-commitment",
    "text": "Play: Put the top card of your discard pile on the bottom of your deck. Make a token creature.",
    "textSha256": "b9ad020faf941fa2447e63ecc19aceee67139554401fafed92fe206445588329"
  },
  "big-sal": {
    "source": "toc",
    "sourceId": "big-sal",
    "text": "Taunt.\nPlay: Make two token creatures.",
    "textSha256": "1b798ee2784eddb4c90475e7e20b40057b33ab25032c2a833f61af253a5b2ceb"
  },
  "rich-score": {
    "source": "toc",
    "sourceId": "rich-score",
    "text": "Play: Make a token creature. Steal  equal to half the number of friendly token creatures (rounded up).",
    "textSha256": "529309e6b5a2c14ae8917ae85db5e76c14bae2df0103cbab08cd5310136c34d2"
  },
  "cover-operation": {
    "source": "toc",
    "sourceId": "cover-operation",
    "text": "Play: Make a token creature, then ready it.",
    "textSha256": "bfc64af4881e72f1db93dc381dd0b9963761ebe28fbbbf1e0812287cfbd14df0"
  },
  "lurking-hob": {
    "source": "toc",
    "sourceId": "lurking-hob",
    "text": "Enhance .\nAfter Reap: Make a token creature.",
    "textSha256": "45f41a488f0252606cc487668dc2bcf88f3631ac2fd654574df3064b557c4e2a"
  },
  "sneaky-feats": {
    "source": "toc",
    "sourceId": "sneaky-feats",
    "text": "Play: Make a token creature. If you have stolen at least 1 this turn, archive Sneaky Feats.",
    "textSha256": "d0e4195f5318c1bd2f8b496870013e161a7221767ca874ca962eedb26f68afb8"
  },
  "captain-pella": {
    "source": "toc",
    "sourceId": "captain-pella",
    "text": "Enhance .\nAfter Reap: Make a token creature.",
    "textSha256": "0c6c543bc757d49461f44c89e863d785dfb63b8e560249f39c514041d12b15a6"
  },
  "umwas": {
    "source": "toc",
    "sourceId": "umwas",
    "text": "Play: Make a token creature. Give each friendly token creature a +1 power counter.",
    "textSha256": "464369dddcb8b3d8f29846f311c79e59a4f97a6f7af2a547358eee2e90e6dc0b"
  },
  "massing-at-midnight": {
    "source": "toc",
    "sourceId": "massing-at-midnight",
    "text": "Play: Make 3 token creatures. Purge Massing at Midnight.",
    "textSha256": "96998f38009a0f004df39463d9a9746e4bdd1a21c5188d1a6bfa0b9c0a8883bf"
  },
  "signal-faerie": {
    "source": "toc",
    "sourceId": "signal-faerie",
    "text": "Play/After Reap: Make a token creature.",
    "textSha256": "294c456b42bd02c237a660efbbec3860f87d5ca571e49826aba4fe3aa89d8742"
  },
  "survival-of-the-richest": {
    "source": "toc",
    "sourceId": "survival-of-the-richest",
    "text": "Play: Make a token creature. If you have more  than your opponent, archive Survival of the Richest.",
    "textSha256": "8078aa77164d2903263183f75682451f46b312d8227c2faa47b9ee5d3c11bac8"
  },
  "codex-of-true-names": {
    "source": "toc",
    "sourceId": "codex-of-true-names",
    "text": "Action: Destroy Codex of True Names. If you do, return each friendly Catena Fiend to its owner’s hand. For each card returned this way, return an enemy creature to its owner’s hand.",
    "textSha256": "eefa4a9025a7de51d896d306edc2838a662f8debd4456f0e40f1a9b3bb9cf376"
  },
  "suzerain": {
    "source": "toc",
    "sourceId": "suzerain",
    "text": "After Reap: Purge the top card of a player’s deck. If you do, make a Minion.",
    "textSha256": "d783aecbdb8f87af1ac25ca1bf5ad44e6f14708d2bfeb9a7384a0168a46d207c"
  },
  "inevitable-decay": {
    "source": "toc",
    "sourceId": "inevitable-decay",
    "text": "Play: Destroy each artifact and upgrade. For each card destroyed this way, make a token creature.",
    "textSha256": "765a3056c0f2f6e91238cb8059ee093cd6e1dd85a00c5a0e1fa645baae229a74"
  },
  "recycler": {
    "source": "toc",
    "sourceId": "recycler",
    "text": "After Reap: Discard the top 3 cards of your deck. For each creature discarded this way, make a token creature.",
    "textSha256": "8b1c3328bbeed3ea63122fd41f18236b8a86753d3aad5d95df72f5dea356be67"
  },
  "spinnertech": {
    "source": "toc",
    "sourceId": "spinnertech",
    "text": "Play/Destroyed: Choose a card in your discard pile and put it on top of your deck. Make a token creature.",
    "textSha256": "2f94b027b5f1665ed1b92ca6a8e0a16c3759ffd21f89b74804a3f66d71ce8dfc"
  },
  "titan-outpost": {
    "source": "toc",
    "sourceId": "titan-outpost",
    "text": "Action: Put a friendly creature on the bottom of its owner's deck. If you do, make a token creature and archive a card.",
    "textSha256": "fd077d687f4184e5e50dc4a55b7c88e83ceae7abbb594c3d6dfa9f601981d75f"
  },
  "practical-methods": {
    "source": "toc",
    "sourceId": "practical-methods",
    "text": "Play: Make a token creature. Destroy a friendly creature and an enemy creature.",
    "textSha256": "04e8d5f75cd100489073dd28ef0e8e3f8aa570b3351e9f4569d04c06dd6399d5"
  },
  "vindication-outpost": {
    "source": "toc",
    "sourceId": "vindication-outpost",
    "text": "Action: Put a friendly creature on the bottom of its owner's deck. If you do, make a token creature, ready it, and fight with it.",
    "textSha256": "aebc63e61831003badb01931f233e1e0d818f5e0a2207990607d60c3bc448ee1"
  },
  "swift-induction": {
    "source": "toc",
    "sourceId": "swift-induction",
    "text": "Play: Make a token creature. If that token creature enters play adjacent to a Mutant creature, archive Swift Induction.",
    "textSha256": "0fdb3696e9784ead8a99f3d6de2d61690af7d775c621d9047cc1d2ecc1cd5726"
  },
  "the-long-con": {
    "source": "toc",
    "sourceId": "the-long-con",
    "text": "Each friendly Stooge cannot reap.\nAction: Make a Stooge. Destroy any number of friendly Stooges. If 6 or more Stooges are destroyed this way, forge a key at no cost and purge The Long Con.",
    "textSha256": "05010cc078b5e352f30f55f9825631873b9ac8048d9b177b7423f71d3c5adfd2"
  },
  "kymoor-outpost": {
    "source": "toc",
    "sourceId": "kymoor-outpost",
    "text": "Action: Put a friendly creature on the bottom of its owner's deck. If you do, steal 1 and make a token creature.",
    "textSha256": "e643ee7005d2cc96823070d9f8a51491b0376299751ff6e178675cbb0346626b"
  },
  "slipshot": {
    "source": "toc",
    "sourceId": "slipshot",
    "text": "After a neighbor of Slipshot is destroyed, ready Slipshot.\nPlay: Make a token creature.",
    "textSha256": "8fdc8f3e8348c25c56fefb05140267adef297170ca79213cd17b2040da3d68bf"
  },
  "niffle-sanctuary": {
    "source": "toc",
    "sourceId": "niffle-sanctuary",
    "text": "Action: Make a Niffle Brute. Until the end of the turn each Niffle Brute gains, “After Fight: Gain 1.”",
    "textSha256": "9935a9ad67181bbf485ec15cedecb2d424ad1b9c9b06008d01f7c506a65a0c26"
  },
  "harlock": {
    "source": "toc",
    "sourceId": "harlock",
    "text": "Skirmish.\nAfter Fight: If the creature Harlock fought was destroyed, make a token creature.",
    "textSha256": "9b972b91d17e55407fdc65fc411e9851d48a4fb763385fc2cdf40a46dd6425c6"
  },
  "kharisma": {
    "source": "toc",
    "sourceId": "kharisma",
    "text": "Elusive.\nAfter Reap: Return another friendly creature to its owner's hand. If you do, make a token creature.",
    "textSha256": "448a2e0d467230acd1a02cd8b65c3e5d3cb860dec1dac931b062c94ed5c369fb"
  },
  "redeemer-amara": {
    "source": "toc",
    "sourceId": "redeemer-amara",
    "text": "Each time an enemy creature or a Mutant creature is destroyed, make a token creature.",
    "textSha256": "a95294f2f0b69fb9253c66d87780af888f57ca907518d19084b01295a488b0c8"
  },
  "balaenora": {
    "source": "toc",
    "sourceId": "balaenora",
    "text": "Balaenora cannot be played unless your opponent has 7 or more in their pool.\nPlay: Capture all of your opponent's .\nAfter Fight: Give control of Balaenora to your opponent.",
    "textSha256": "39c10979a88c079986c372cb783ea76c84a725d9413922e50d0654daa1c192bd"
  },
  "whimsical-conjuror": {
    "source": "toc",
    "sourceId": "whimsical-conjuror",
    "text": "Enhance .\nWhen you resolve an  bonus icon, you may make a token creature instead.",
    "textSha256": "dbe825c96956e87d47243a47ebb7d9e12395240555cba4078d48064d85031feb"
  },
  "toc-token-catena-fiend": {
    "source": "toc",
    "sourceId": "catena-fiend",
    "text": "After Fight: Steal 1. Deal 3 to a friendly creature.",
    "textSha256": "645d75b4e32d808e809ceab026f72af1e221f70601191836bbedff4962e56102"
  },
  "toc-token-facet": {
    "source": "toc",
    "sourceId": "facet",
    "text": "Destroyed: If it is your turn, gain 1.",
    "textSha256": "11ab4ce11cdd0f6cf109384e8a0abc4a73c75bc96e582889dc28bd8784b10b0e"
  },
  "toc-token-snare": {
    "source": "toc",
    "sourceId": "snare",
    "text": "Destroyed: If it is your turn, your opponent loses 1.",
    "textSha256": "65b5a2f733b218457bb2f30a8a3095f1cf103e8f5134abbea1dcb06386ce70e8"
  },
  "toc-token-thrall": {
    "source": "toc",
    "sourceId": "thrall",
    "text": "Destroyed: Your opponent discards a random card from their hand.",
    "textSha256": "25ed0fbddba922ca43715061d5b11a737f3a580bd997021c1b9a3d20ff8d3fa1"
  },
  "toc-token-minion": {
    "source": "toc",
    "sourceId": "minion",
    "text": "After Reap: Put the top card of a haunted player’s discard pile on top of its owner’s deck.",
    "textSha256": "b52049ffb39e356cdafb925320b14ebb7b66dffc455b1ee0b3d30f86a51d3129"
  },
  "toc-token-phantasm": {
    "source": "toc",
    "sourceId": "phantasm",
    "text": "After Reap: Discard a card from your hand.",
    "textSha256": "5eab6b304cde42bddcb614634bea0baa04f48130cdee87446324afeadff160ea"
  },
  "toc-token-wrecker": {
    "source": "toc",
    "sourceId": "wrecker",
    "text": "After Reap: Discard the top card of a player’s deck.",
    "textSha256": "2bb7c8472329ad57e9cd4ddba7fee1c2d51212b4c6b99123f95e529d5d44a84d"
  },
  "toc-token-æmberologist": {
    "source": "toc",
    "sourceId": "æmberologist",
    "text": "Action: Capture 1.",
    "textSha256": "034e846897799074b0c6d9284675c768f5002bc15658c448cb8e0a5fd728304c"
  },
  "toc-token-alpha-gamma": {
    "source": "toc",
    "sourceId": "alpha-gamma",
    "text": "Destroyed: Archive Alpha-Gamma.",
    "textSha256": "0000b077eb41234d06dc81be1250c6f0ae0853ad2b5f02548b515400cbbb1837"
  },
  "toc-token-chronicler": {
    "source": "toc",
    "sourceId": "chronicler",
    "text": "After Reap: Archive the top card of your deck.",
    "textSha256": "a63c19a45e4f9fb36e2262afcb0385c66995d8eea7ddeedb7907488d998df530"
  },
  "toc-token-savant": {
    "source": "toc",
    "sourceId": "savant",
    "text": "Action: You may choose a card in your archives and put it into its owner’s hand. Otherwise, archive a card.",
    "textSha256": "6ada86a6a2f5a77f142398005c22664e6a4ae3c01f1acf7f464b95273c01a824"
  },
  "toc-token-spydrone": {
    "source": "toc",
    "sourceId": "spydrone",
    "text": "Elusive.\nAction: Draw a card.",
    "textSha256": "07347db7712291682760c9810a037c54208976eaab7570f009dc52e189cb422a"
  },
  "toc-token-zealot": {
    "source": "toc",
    "sourceId": "zealot",
    "text": "Assault 2.",
    "textSha256": "432d747e4100c55c203d212e31c36dda6370056248bea996b229212ed3991262"
  },
  "toc-token-guardian": {
    "source": "toc",
    "sourceId": "guardian",
    "text": "",
    "textSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  "toc-token-paragon": {
    "source": "toc",
    "sourceId": "paragon",
    "text": "If there is a Mutant creature in play, Paragon enters play enraged.",
    "textSha256": "5f21a702c3cffb09f9cca22b35f7e72236929be78fef30372ea832ff337f4d1f"
  },
  "toc-token-sentinel": {
    "source": "toc",
    "sourceId": "sentinel",
    "text": "Action: Stun an enemy creature. If that creature was already stunned, destroy it instead.",
    "textSha256": "c5576fbb3e51ec7c2648978b910b21a45ec5120a004d5d38d331c1c4ddcd6379"
  },
  "toc-token-stooge": {
    "source": "toc",
    "sourceId": "stooge",
    "text": "Action: If Stooge is on a flank, make a token creature.",
    "textSha256": "807311011d9dfa8c84240bc007da5949c7c295bc33ad915339427588c8d5809a"
  },
  "toc-token-cleaner": {
    "source": "toc",
    "sourceId": "cleaner",
    "text": "Action: Deal 3 to a creature.",
    "textSha256": "199280768792eef7fe331c545465c6fc826d047d95ddb8bebbbd71ab5b30e3f2"
  },
  "toc-token-prowler": {
    "source": "toc",
    "sourceId": "prowler",
    "text": "After Reap: If your opponent has more  than you, steal 1.",
    "textSha256": "e3b57d1703d0b7a6ec5990ff263f0adde59cdf39c76b58508d5cc30a81e61481"
  },
  "toc-token-yardbird": {
    "source": "toc",
    "sourceId": "yardbird",
    "text": "Elusive.\nBefore Fight: Ready another Yardbird.",
    "textSha256": "805b341c55cab35dd9123e02cee6c8d20b081257cc8579d68009a82435680490"
  },
  "toc-token-wrangler": {
    "source": "toc",
    "sourceId": "wrangler",
    "text": "Action: Each player gains 1.",
    "textSha256": "4ae36c87c0228c2d12e42ef8884bcdb5563ba4eb6ee744adb50245a567bbb23b"
  },
  "toc-token-aerialist": {
    "source": "toc",
    "sourceId": "aerialist",
    "text": "While your yellow key is forged, Aerialist gains, “After Reap: Capture 1.”",
    "textSha256": "0373578f74980e6f0218100ffe22e3a2fdcf30a800ec458f9d371805d6176e6f"
  },
  "toc-token-corsair": {
    "source": "toc",
    "sourceId": "corsair",
    "text": "While your red key is forged, Corsair gets +1 power and gains skirmish.",
    "textSha256": "808ae1d478f2887fd8fb23051311ead7bce210b8ca2e1a79d7405eafdcf27d1e"
  },
  "toc-token-marketeer": {
    "source": "toc",
    "sourceId": "marketeer",
    "text": "While your blue key is forged, Marketeer gains, “Action: Gain 2. Destroy Marketeer.”",
    "textSha256": "21b22c63cde73ca7f83d4c2962a12d07a402219fb5b6b5e41c6a65e9ecf99608"
  },
  "toc-token-niffle-brute": {
    "source": "toc",
    "sourceId": "niffle-brute",
    "text": "Destroyed: If Niffle Sanctuary is in your discard pile, return it to your hand. Otherwise, return a Niffle card from your discard pile to your hand.",
    "textSha256": "76615647c67320d3dfa9e9a045c11eefa08efe5865e49e978c2f983c8647551d"
  },
  "toc-token-briar-instar": {
    "source": "toc",
    "sourceId": "briar-instar",
    "text": "Hazardous 2.",
    "textSha256": "68250b4941e8caee79c180bf8004b1b96c27e878c8aca732ee91e9ffd3447181"
  },
  "toc-token-steppe-wolf": {
    "source": "toc",
    "sourceId": "steppe-wolf",
    "text": "Steppe Wolf gets +1 power for each other friendly Wolf creature in play.",
    "textSha256": "3547c3a3b3a4ad0793b1940bdc30a0f3b7ccbfdf378d37570e6e19a8b176d65d"
  },
  "toc-token-twilight-pixie": {
    "source": "toc",
    "sourceId": "twilight-pixie",
    "text": "Each of Twilight Pixie’s non-Faerie neighbors gains, “After Reap: Gain 1.”",
    "textSha256": "1ff11c3cb9f2682935d903d64a72547ca3af0396f029b632d3fa6e48318a642f"
  },
  "woe-token-skirmisher": {
    "source": "woe-token",
    "sourceId": "skirmisher",
    "text": "Skirmish. (When you use this creature to fight, it is dealt no damage in return.)",
    "textSha256": "d4fae45c486103245ab62d44b414bd816b159b995da38a173bcb11e17da05db7"
  },
  "woe-token-squire": {
    "source": "woe-token",
    "sourceId": "squire",
    "text": "Taunt. (This creature’s neighbors cannot be attacked unless they have taunt.)",
    "textSha256": "7c82a08e50cf325aa9660cb5248dc4a49a325f3fdb67bd39404c9732e7f9967f"
  },
  "woe-token-strange-shell": {
    "source": "woe-token",
    "sourceId": "strange-shell",
    "text": "Strange Shell cannot fight or reap.\nAction: Put Strange Shell into your hand.",
    "textSha256": "f5e9d75a8228217a59833390d9168f57926af96f06b5d5a02046fa220ae8677b"
  },
  "woe-token-diplomat": {
    "source": "woe-token",
    "sourceId": "diplomat",
    "text": "Elusive. (The first time this creature is attacked each turn, no damage is dealt.)\nAfter Reap: Each player gains 1.",
    "textSha256": "afcbdfe3204e2c4db1b9406540c8619a645cf40444a22c747f63400936318837"
  },
  "woe-token-trader": {
    "source": "woe-token",
    "sourceId": "trader",
    "text": "Action: Steal 1. Destroy Trader.",
    "textSha256": "e20516116efa1244855241c976d5611487dd2c3b25ff3d3953a6ba1b46fe562b"
  },
  "woe-token-prospector": {
    "source": "woe-token",
    "sourceId": "prospector",
    "text": "Destroyed: Draw a card.",
    "textSha256": "dd5b76e243c866d433edba7598c1478f279286eff28d7115dda8f0c144e03a72"
  },
  "woe-token-rebel": {
    "source": "woe-token",
    "sourceId": "rebel",
    "text": "After Reap: Deal 1 to a creature.",
    "textSha256": "5c5edc030586ceb8fef17dda3202948c4aff62ab6c8777b332ac0a27a0ae0b99"
  },
  "woe-token-scholar": {
    "source": "woe-token",
    "sourceId": "scholar",
    "text": "After Reap: Draw 1 card.",
    "textSha256": "f723c28e1ac8f39fa482aed483d060f79b5bc62608316b0ea5da09000c83d299"
  },
  "woe-token-senator": {
    "source": "woe-token",
    "sourceId": "senator",
    "text": "Action: Keys cost +1 during your opponent’s next turn.",
    "textSha256": "6612f3c65bf35d2ab9b1cdc3b2a3404d80f4f6ef40ed6a507321d11d9177851c"
  },
  "woe-token-trooper": {
    "source": "woe-token",
    "sourceId": "trooper",
    "text": "After Fight/After Reap: Exalt Trooper.",
    "textSha256": "bce09a6ebdd63384b85357384b3c117300c7ba09e507f1502992df86007d5922"
  },
  "woe-token-priest": {
    "source": "woe-token",
    "sourceId": "priest",
    "text": "Action: Exhaust an enemy creature.",
    "textSha256": "63011871f7ee4dc406afa68b7f6750e97a695a6040acf488dafe5904f0ad53ae"
  },
  "woe-token-berserker": {
    "source": "woe-token",
    "sourceId": "berserker",
    "text": "Berserker enters play ready and enraged. \nAfter Fight: Destroy Berserker.",
    "textSha256": "45ab34cf5bd278ba3917fa510e7bab1d1e7fc8205738dad8776cf0367dbc7295"
  },
  "woe-token-cleric": {
    "source": "woe-token",
    "sourceId": "cleric",
    "text": "After Cleric enters play, capture 1.",
    "textSha256": "e02f8caf34a09029bbda1e840e0e3b7e40f9b00eb8ebc685dd556d5ce8dc1a5b"
  },
  "woe-token-grumpus": {
    "source": "woe-token",
    "sourceId": "grumpus",
    "text": "Splash-attack 1. (When this creature attacks, also deal 1 to each of the attacked creature’s neighbors).",
    "textSha256": "0bdb1cb41cd36e51c8b4b4021f2909657295ffd2f05eb835cdcc02dacc7f447f"
  },
  "woe-token-warrior": {
    "source": "woe-token",
    "sourceId": "warrior",
    "text": "Warrior cannot reap unless there are no enemy creatures in play.",
    "textSha256": "37bfe8166636d9c267f12b81425f0f76e1f106162c18a371f836ada110b17aa5"
  },
  "woe-token-researcher": {
    "source": "woe-token",
    "sourceId": "researcher",
    "text": "Omni: Reveal a Mars card from your hand and archive it.",
    "textSha256": "706b49f2a28412c3f1bf94938ac027a4eac3e98acae92225f98a7822afee17fa"
  },
  "woe-token-disciple": {
    "source": "woe-token",
    "sourceId": "disciple",
    "text": "Disciple gets +1 power and +1 armor for each Monk neighbor it has.",
    "textSha256": "5a4b2426a6838f96c797ec325bdcafc8b162248d297f9399422d6bb586b4e227"
  },
  "woe-token-cadet": {
    "source": "woe-token",
    "sourceId": "cadet",
    "text": "Destroyed: Ready Cadet’s most powerful neighbor.",
    "textSha256": "805a386b5052027f9eae45108700e146ea8a1ff3e0838348d60972c149dcef5d"
  },
  "woe-token-explorer": {
    "source": "woe-token",
    "sourceId": "explorer",
    "text": "After Reap: Look at the top card of your deck. You may discard it.",
    "textSha256": "13fc1894c9eb348e286caf9cee012259dbcb33a221527bfacd86d04dcd71d3d5"
  },
  "woe-token-b0-t": {
    "source": "woe-token",
    "sourceId": "b0-t",
    "text": "Action: Use a friendly non‑Star Alliance creature.",
    "textSha256": "d0b13e1ccf0443d21684b93f201f6e892ad3831132a5c4f2167b95ac0e66b6e8"
  },
  "woe-token-cultist": {
    "source": "woe-token",
    "sourceId": "cultist",
    "text": "Action: Destroy Cultist. If you do, ward a friendly creature.",
    "textSha256": "b453373fe635694cba04025e1e90d79e1837d2a717e8816326dd68dee2a2862d"
  },
  "woe-token-fish": {
    "source": "woe-token",
    "sourceId": "fish",
    "text": "Destroyed: Deal 2 to the most powerful enemy creature.",
    "textSha256": "d59f2dd1bd3fb0f9bfd36f2eaf2388ad2b5700001ece6df584bbdf159e736ec2"
  },
  "woe-token-raider": {
    "source": "woe-token",
    "sourceId": "raider",
    "text": "Raider gains poison during your turn.\n(On your turn, any damage dealt by this creature’s power during a fight destroys the damaged creature.)",
    "textSha256": "aca624611c668917d837a741a5675174e08e8949ac12ad4b7898ad1801989e04"
  },
  "woe-token-æmberling": {
    "source": "woe-token",
    "sourceId": "æmberling",
    "text": "Æmberling cannot reap.\nYou may spend Æmberling as if it were  in your pool. (Discard it, ignoring wards.)",
    "textSha256": "91852f8950d37ab7cc2fee436ac835bceebc3330411f93d9c68f9046d521cab9"
  },
  "woe-token-blorb": {
    "source": "woe-token",
    "sourceId": "blorb",
    "text": "Elusive. Blorb cannot reap.\nDestroyed: Return Blorb Hive from your discard pile to your hand.",
    "textSha256": "f125ccdf275d33694c6d32c303a073f3fbd6387649ce51e5f1d3047a8f0c454f"
  }
};
