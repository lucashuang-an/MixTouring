/* MixTouring HIFI — mock.js · 全链路单一数据源
 * ⚠️ 本文件由 pipeline/build-mock.mjs 生成，请勿手改；数据维护在 pipeline/data/plans.json
 * 生成时间：2026-09-09T15:28:44.228Z · 数据版本：0.1.0 */
(function () {
  'use strict';

  var CITIES = ["北京","上海","广州","深圳","成都","重庆","西安","杭州","武汉","南京","长沙","厦门","昆明","三亚","哈尔滨","沈阳","乌鲁木齐","喀什","拉萨","贵阳","兰州","银川","西宁","海口"];

  var ROUTES = {
  "北京-喀什": {
    "direct": {
      "price": "¥2,480",
      "time": "6h20m",
      "note": "直飞基准 · 北京 ⇄ 喀什"
    },
    "plans": [
      {
        "id": "p-bjks-1",
        "type": "plan",
        "from": "北京",
        "to": "喀什",
        "totalTime": "总 23h17m",
        "price": "¥1,115–1,255",
        "priceMid": 1185,
        "saved": "省 ¥1,295",
        "modes": [
          "train",
          "plane"
        ],
        "stops": [
          {
            "name": "北京",
            "sub": "21:30"
          },
          {
            "name": "银川",
            "sub": "停 1h53m"
          },
          {
            "name": "阿克苏",
            "sub": "停 1h40m"
          },
          {
            "name": "喀什",
            "sub": "D2 20:47"
          }
        ],
        "segs": [
          {
            "mode": "train",
            "dur": "10h42m",
            "fromStation": "北京西",
            "toStation": "银川",
            "dep": "21:30",
            "arr": "08:12",
            "arrNote": "次日",
            "price": "¥263"
          },
          {
            "mode": "plane",
            "dur": "3h35m",
            "fromStation": "银川河东",
            "toStation": "阿克苏",
            "dep": "10:05",
            "arr": "13:40",
            "price": "¥780–¥920"
          },
          {
            "mode": "train",
            "dur": "5h27m",
            "fromStation": "阿克苏",
            "toStation": "喀什",
            "dep": "15:20",
            "arr": "20:47",
            "price": "¥72"
          }
        ],
        "risks": [
          {
            "title": "衔接时间余量 · 银川 1h53m",
            "level": "高",
            "lines": [
              "跨站接驳后余量不足 1 小时",
              "误机将错过每日 2 班的航班"
            ]
          },
          {
            "title": "行李不直挂",
            "level": "中",
            "lines": [
              "火车转飞机需自行提取并重新托运",
              "建议预留 30 分钟"
            ]
          },
          {
            "title": "退改规则",
            "level": "低",
            "lines": [
              "机票段为 4 折以上舱位，可改期",
              "火车票开车前可退"
            ]
          },
          {
            "title": "接驳 · 跨站/机场",
            "level": "中",
            "lines": [
              "银川站 → 河东机场 18 公里，接驳 40 分钟"
            ]
          }
        ],
        "play": {
          "city": "银川",
          "lines": [
            "若改签到次日航班",
            "镇北堡西部影城（市区打车 40 分钟）",
            "怀远夜市（人均 ¥35 吃撑）",
            "当地物价：住宿 ¥90–150/晚",
            "机场巴士 ¥20"
          ]
        },
        "ai": {
          "summary": "火车混搭飞机，比直飞省 ¥1,295，银川中转还能逛夜市",
          "fit": "适合时间相对充裕、想大幅压预算的背包客；行李多的话要掂量转运",
          "notice": "银川转机窗口 1h53m，下火车直接奔机场巴士，别在市区逗留",
          "play_intro": "若改签到次日航班，镇北堡西部影城和怀远夜市值得专门留一晚"
        },
        "geo": {
          "verdict": "mainstream",
          "ratio": 1.03,
          "extraKm": 99,
          "estExtraHours": 0,
          "conclusion": null
        }
      },
      {
        "id": "p-bjks-2",
        "type": "plan",
        "from": "北京",
        "to": "喀什",
        "totalTime": "总 45h45m",
        "price": "¥727",
        "priceMid": 727,
        "saved": "省 ¥1,753",
        "modes": [
          "train"
        ],
        "stops": [
          {
            "name": "北京",
            "sub": "18:00"
          },
          {
            "name": "兰州",
            "sub": "停 3h20m"
          },
          {
            "name": "喀什",
            "sub": "D3 15:45"
          }
        ],
        "segs": [
          {
            "mode": "train",
            "dur": "16h55m",
            "fromStation": "北京西",
            "toStation": "兰州",
            "dep": "18:00",
            "arr": "10:55",
            "arrNote": "次日",
            "price": "¥343"
          },
          {
            "mode": "train",
            "dur": "25h30m",
            "fromStation": "兰州",
            "toStation": "喀什",
            "dep": "14:15",
            "arr": "15:45",
            "arrNote": "次日",
            "price": "¥384"
          }
        ],
        "risks": [
          {
            "title": "衔接时间余量 · 兰州 3h20m",
            "level": "低",
            "lines": [
              "同站换乘，余量充足",
              "误车风险低，可出站活动"
            ]
          },
          {
            "title": "行李直挂",
            "level": "低",
            "lines": [
              "全程火车，随身带上车",
              "无需中途托运"
            ]
          },
          {
            "title": "退改规则",
            "level": "低",
            "lines": [
              "均为火车票，开车前可退"
            ]
          },
          {
            "title": "接驳 · 站内换乘",
            "level": "低",
            "lines": [
              "兰州站同站换乘，无需出站"
            ]
          }
        ],
        "play": {
          "city": "兰州",
          "lines": [
            "3 小时够吃一碗正经牛肉面",
            "正宁路夜市（兰州站打车 15 分钟）",
            "黄河铁桥散步消食",
            "车站寄存行李 ¥10/件"
          ]
        },
        "ai": {
          "summary": "全程火车坐到底，¥727 出头到喀什，省 ¥1,753",
          "fit": "适合把火车当风景的慢旅行者；卧铺两晚，时间成本高",
          "notice": "兰州换乘 3h20m 很从容，备足两顿干粮和充电宝",
          "play_intro": "兰州间隙够吃一碗正经牛肉面，正宁路夜市离车站不远"
        },
        "geo": {
          "verdict": "mainstream",
          "ratio": 1.06,
          "extraKm": 218,
          "estExtraHours": 1.8,
          "conclusion": null
        }
      },
      {
        "id": "p-bjks-3",
        "type": "plan",
        "from": "北京",
        "to": "喀什",
        "totalTime": "总 10h20m",
        "price": "¥1,495–1,665",
        "priceMid": 1580,
        "saved": "省 ¥900",
        "modes": [
          "train",
          "plane"
        ],
        "stops": [
          {
            "name": "北京",
            "sub": "07:00"
          },
          {
            "name": "西安",
            "sub": "停 1h09m"
          },
          {
            "name": "喀什",
            "sub": "17:20"
          }
        ],
        "segs": [
          {
            "mode": "train",
            "dur": "4h31m",
            "fromStation": "北京西",
            "toStation": "西安北",
            "dep": "07:00",
            "arr": "11:31",
            "price": "¥515"
          },
          {
            "mode": "plane",
            "dur": "4h40m",
            "fromStation": "西安咸阳",
            "toStation": "喀什",
            "dep": "12:40",
            "arr": "17:20",
            "price": "¥980–¥1,150"
          }
        ],
        "risks": [
          {
            "title": "衔接时间余量 · 西安 1h09m",
            "level": "高",
            "lines": [
              "跨站接驳后余量不足 1 小时",
              "高铁到后需跨站赶往机场，下车即走"
            ]
          },
          {
            "title": "行李不直挂",
            "level": "中",
            "lines": [
              "火车转飞机需自行提取并重新托运",
              "高峰期托运排队 20 分钟以上"
            ]
          },
          {
            "title": "退改规则",
            "level": "中",
            "lines": [
              "机票段为特价舱，改期费较高",
              "误机基本全损"
            ]
          },
          {
            "title": "接驳 · 跨站/机场",
            "level": "高",
            "lines": [
              "西安北站 → 咸阳机场 33 公里，轨交 33 分钟",
              "含步行与安检，时间非常紧张"
            ]
          }
        ],
        "play": {
          "city": "西安",
          "lines": [
            "若改签到次日航班",
            "兵马俑（地铁 9 号线直达）",
            "回民街宵夜（人均 ¥40）",
            "机场城际末班 22:30，留意返程"
          ]
        },
        "ai": {
          "summary": "最快的混搭方案，10h20m 到喀什，仍省 ¥900",
          "fit": "适合假期短、愿意用钱换时间的人；衔接紧张，不适合首次独自出行",
          "notice": "西安转机窗口仅 1h09m 且要跨站赶机场，高铁尽量买靠车门座位",
          "play_intro": "若改签到次日航班，兵马俑加回民街刚好一天"
        },
        "geo": {
          "verdict": "mainstream",
          "ratio": 1.13,
          "extraKm": 444,
          "estExtraHours": 0,
          "conclusion": null
        }
      }
    ]
  },
  "北京-乌鲁木齐": {
    "direct": {
      "price": "¥1,650",
      "time": "4h15m",
      "note": "直飞基准 · 北京 ⇄ 乌鲁木齐"
    },
    "plans": [
      {
        "id": "p-bjwl-1",
        "type": "plan",
        "from": "北京",
        "to": "乌鲁木齐",
        "totalTime": "总 31h09m",
        "price": "¥890",
        "priceMid": 890,
        "saved": "省 ¥760",
        "modes": [
          "train"
        ],
        "stops": [
          {
            "name": "北京",
            "sub": "17:56"
          },
          {
            "name": "兰州",
            "sub": "停 2h15m"
          },
          {
            "name": "乌鲁木齐",
            "sub": "D3 01:05"
          }
        ],
        "segs": [
          {
            "mode": "train",
            "dur": "17h05m",
            "fromStation": "北京西",
            "toStation": "兰州",
            "dep": "17:56",
            "arr": "11:01",
            "arrNote": "次日",
            "price": "¥363"
          },
          {
            "mode": "train",
            "dur": "11h49m",
            "fromStation": "兰州西",
            "toStation": "乌鲁木齐",
            "dep": "13:16",
            "arr": "01:05",
            "arrNote": "次日",
            "price": "¥527"
          }
        ],
        "risks": [
          {
            "title": "衔接时间余量 · 兰州 2h15m",
            "level": "中",
            "lines": [
              "扣除接驳与缓冲后余量约 1.5 小时",
              "到达兰州站、出发兰州西站，需跨站"
            ]
          },
          {
            "title": "行李直挂",
            "level": "低",
            "lines": [
              "全程火车，随身带上车",
              "无需中途托运"
            ]
          },
          {
            "title": "退改规则",
            "level": "低",
            "lines": [
              "均为火车票，开车前可退"
            ]
          },
          {
            "title": "接驳 · 跨站/机场",
            "level": "中",
            "lines": [
              "兰州站 → 兰州西站 10 公里，轨交 25 分钟",
              "行李多建议打车约 ¥20"
            ]
          }
        ],
        "play": {
          "city": "兰州",
          "lines": [
            "换乘间隙吃碗牛肉面再走",
            "兰州西站候车厅有免费充电区",
            "进疆列车昼夜温差大，备件外套"
          ]
        },
        "ai": {
          "summary": "兰新线一路向西，全程火车省 ¥760，卧铺一晚到",
          "fit": "适合想看河西走廊风景、不赶时间的人；要在兰州跨站换车",
          "notice": "兰州站换兰州西站，地铁 25 分钟直达，2h15m 的余量不用慌",
          "play_intro": "换乘间隙去正宁路吃碗面，回站前留好地铁时间"
        },
        "geo": {
          "verdict": "mainstream",
          "ratio": 1.16,
          "extraKm": 395,
          "estExtraHours": 3.3,
          "conclusion": null
        }
      },
      {
        "id": "p-bjwl-2",
        "type": "plan",
        "from": "北京",
        "to": "乌鲁木齐",
        "totalTime": "总 16h42m",
        "price": "¥883–1,023",
        "priceMid": 953,
        "saved": "省 ¥697",
        "modes": [
          "train",
          "plane"
        ],
        "stops": [
          {
            "name": "北京",
            "sub": "21:30"
          },
          {
            "name": "银川",
            "sub": "停 2h40m"
          },
          {
            "name": "乌鲁木齐",
            "sub": "D2 14:12"
          }
        ],
        "segs": [
          {
            "mode": "train",
            "dur": "10h42m",
            "fromStation": "北京西",
            "toStation": "银川",
            "dep": "21:30",
            "arr": "08:12",
            "arrNote": "次日",
            "price": "¥263"
          },
          {
            "mode": "plane",
            "dur": "3h20m",
            "fromStation": "银川河东",
            "toStation": "乌鲁木齐地窝堡",
            "dep": "10:52",
            "arr": "14:12",
            "price": "¥620–¥760"
          }
        ],
        "risks": [
          {
            "title": "衔接时间余量 · 银川 2h40m",
            "level": "中",
            "lines": [
              "扣除接驳与缓冲后余量约 1.5 小时",
              "机场巴士整点发车，留意时刻"
            ]
          },
          {
            "title": "行李不直挂",
            "level": "中",
            "lines": [
              "火车转飞机需自行提取并重新托运",
              "建议预留 30 分钟"
            ]
          },
          {
            "title": "退改规则",
            "level": "中",
            "lines": [
              "机票段为特价舱，改期费较高",
              "火车票开车前可退"
            ]
          },
          {
            "title": "接驳 · 跨站/机场",
            "level": "中",
            "lines": [
              "银川站 → 河东机场 18 公里，接驳 40 分钟",
              "机场巴士 ¥20"
            ]
          }
        ],
        "play": {
          "city": "银川",
          "lines": [
            "早到可在市区吃个羊杂碎",
            "河东机场安检人不多，体验好",
            "机场巴士整点发车，留意时刻"
          ]
        },
        "ai": {
          "summary": "夕发朝至到银川再飞，16h42m 到乌鲁木齐，省 ¥697",
          "fit": "适合想平衡时间与预算的人；转机行李要自己搬运",
          "notice": "银川机场巴士整点发车，下火车先看时刻表，2h40m 的窗口别误车",
          "play_intro": "早到银川先吃碗羊杂碎，河东机场安检体验友好"
        },
        "geo": {
          "verdict": "mainstream",
          "ratio": 1.06,
          "extraKm": 142,
          "estExtraHours": 0,
          "conclusion": null
        }
      }
    ]
  },
  "上海-昆明": {
    "direct": {
      "price": "¥1,260",
      "time": "3h40m",
      "note": "直飞基准 · 上海 ⇄ 昆明"
    },
    "plans": [
      {
        "id": "p-shkm-1",
        "type": "plan",
        "from": "上海",
        "to": "昆明",
        "totalTime": "总 13h45m",
        "price": "¥720",
        "priceMid": 720,
        "saved": "省 ¥540",
        "modes": [
          "train"
        ],
        "stops": [
          {
            "name": "上海",
            "sub": "08:35"
          },
          {
            "name": "贵阳",
            "sub": "停 2h12m"
          },
          {
            "name": "昆明",
            "sub": "22:20"
          }
        ],
        "segs": [
          {
            "mode": "train",
            "dur": "9h05m",
            "fromStation": "上海虹桥",
            "toStation": "贵阳北",
            "dep": "08:35",
            "arr": "17:40",
            "price": "¥508"
          },
          {
            "mode": "train",
            "dur": "2h28m",
            "fromStation": "贵阳北",
            "toStation": "昆明南",
            "dep": "19:52",
            "arr": "22:20",
            "price": "¥212"
          }
        ],
        "risks": [
          {
            "title": "衔接时间余量 · 贵阳 2h12m",
            "level": "低",
            "lines": [
              "同站换乘，余量充足",
              "误车风险低"
            ]
          },
          {
            "title": "行李直挂",
            "level": "低",
            "lines": [
              "全程火车，随身带上车",
              "无需中途托运"
            ]
          },
          {
            "title": "退改规则",
            "level": "中",
            "lines": [
              "票源紧张，退票后可能买不到原班次",
              "高铁票开车前可退"
            ]
          },
          {
            "title": "接驳 · 站内换乘",
            "level": "低",
            "lines": [
              "贵阳北站内换乘，无需出站"
            ]
          }
        ],
        "play": {
          "city": "贵阳",
          "lines": [
            "2 小时够在站内吃个丝娃娃",
            "甲秀楼夜景（打车 25 分钟）",
            "贵阳北站行李寄存 ¥15/件"
          ]
        },
        "ai": {
          "summary": "全程高铁坐着到昆明，省 ¥540，贵阳站内换乘",
          "fit": "适合不想折腾行李、追求稳妥的人",
          "notice": "贵阳北换乘通道步行约 12 分钟，2h12m 足够吃口饭",
          "play_intro": "间隙试试站内丝娃娃，或者打车去看甲秀楼"
        },
        "geo": {
          "verdict": "mainstream",
          "ratio": 1,
          "extraKm": 0,
          "estExtraHours": 0,
          "conclusion": null
        }
      },
      {
        "id": "p-shkm-2",
        "type": "plan",
        "from": "上海",
        "to": "昆明",
        "totalTime": "总 6h40m",
        "price": "¥593–753",
        "priceMid": 673,
        "saved": "省 ¥587",
        "modes": [
          "train",
          "plane"
        ],
        "stops": [
          {
            "name": "上海",
            "sub": "07:00"
          },
          {
            "name": "杭州",
            "sub": "停 2h30m"
          },
          {
            "name": "昆明",
            "sub": "13:40"
          }
        ],
        "segs": [
          {
            "mode": "train",
            "dur": "1h00m",
            "fromStation": "上海虹桥",
            "toStation": "杭州东",
            "dep": "07:00",
            "arr": "08:00",
            "price": "¥73"
          },
          {
            "mode": "plane",
            "dur": "3h10m",
            "fromStation": "杭州萧山",
            "toStation": "昆明长水",
            "dep": "10:30",
            "arr": "13:40",
            "price": "¥520–¥680"
          }
        ],
        "risks": [
          {
            "title": "衔接时间余量 · 杭州 2h30m",
            "level": "中",
            "lines": [
              "扣除接驳与缓冲后余量约 1 小时",
              "杭州东站需跨站至萧山机场"
            ]
          },
          {
            "title": "行李不直挂",
            "level": "中",
            "lines": [
              "火车转飞机需自行提取并重新托运",
              "建议预留 30 分钟"
            ]
          },
          {
            "title": "退改规则",
            "level": "中",
            "lines": [
              "机票段为特价舱，改期费较高",
              "高铁票开车前可退"
            ]
          },
          {
            "title": "接驳 · 跨站/机场",
            "level": "中",
            "lines": [
              "杭州东站 → 萧山机场 27 公里，轨交 50 分钟",
              "19 站直达，无需换乘"
            ]
          }
        ],
        "play": {
          "city": "杭州",
          "lines": [
            "时间紧不建议进市区",
            "萧山机场 T4 有不错的杭帮菜",
            "若改签次日：西湖骑行半日"
          ]
        },
        "ai": {
          "summary": "最快 6h40m 到昆明，省 ¥587，杭州中转",
          "fit": "适合沪杭出发、想把路上时间压到最短的人",
          "notice": "杭州东到萧山机场地铁 50 分钟直达，别贪玩误机",
          "play_intro": "若改签次日，西湖骑行半日再飞"
        },
        "geo": {
          "verdict": "mainstream",
          "ratio": 1.01,
          "extraKm": 16,
          "estExtraHours": 0,
          "conclusion": null
        }
      }
    ]
  },
  "成都-乌鲁木齐": {
    "direct": {
      "price": "¥1,210",
      "time": "3h45m",
      "note": "直飞基准 · 成都 ⇄ 乌鲁木齐"
    },
    "plans": [
      {
        "id": "p-cdwl-1",
        "type": "plan",
        "from": "成都",
        "to": "乌鲁木齐",
        "totalTime": "总 17h28m",
        "price": "¥858–1,208",
        "priceMid": 1033,
        "saved": "省 ¥177",
        "modes": [
          "train",
          "plane"
        ],
        "stops": [
          {
            "name": "成都",
            "sub": "20:42"
          },
          {
            "name": "兰州",
            "sub": "停 3h10m"
          },
          {
            "name": "乌鲁木齐",
            "sub": "D2 14:10"
          }
        ],
        "segs": [
          {
            "mode": "train",
            "dur": "11h28m",
            "fromStation": "成都西",
            "toStation": "兰州",
            "dep": "20:42",
            "arr": "08:10",
            "arrNote": "次日",
            "price": "¥208"
          },
          {
            "mode": "plane",
            "dur": "2h50m",
            "fromStation": "中川机场T3",
            "toStation": "天山国际机场",
            "dep": "11:20",
            "arr": "14:10",
            "price": "¥650–¥1,000"
          }
        ],
        "risks": [
          {
            "title": "衔接时间余量 · 兰州 3h10m",
            "level": "中",
            "lines": [
              "扣除接驳与缓冲后余量约 2 小时",
              "城际动车直达机场航站楼，30–60 分钟一班，误车可等下一班"
            ]
          },
          {
            "title": "行李不直挂",
            "level": "中",
            "lines": [
              "火车转飞机需自行提取并重新托运",
              "建议预留 30 分钟"
            ]
          },
          {
            "title": "退改规则",
            "level": "中",
            "lines": [
              "机票段为特价舱，改期费较高",
              "火车票开车前可退"
            ]
          },
          {
            "title": "接驳 · 跨站/机场",
            "level": "高",
            "lines": [
              "兰州站 → 中川机场 70 公里，轨交 50 分钟",
              "城际二等座 ¥21.5，兰州站有专用进站通道"
            ]
          }
        ],
        "play": {
          "city": "兰州",
          "lines": [
            "出站先吃碗牛肉面，再坐城际去机场",
            "黄河铁桥（中山桥）距兰州站打车 15 分钟",
            "正宁路夜市晚上最热闹，牛奶鸡蛋醪糟必点"
          ]
        },
        "ai": {
          "summary": "夜卧铺睡到兰州，城际转午班机，比直飞省 ¥177",
          "fit": "适合能睡卧铺、想压预算的背包客；怕折腾的选直达火车方案更省心",
          "notice": "兰州站到中川机场 70 公里，城际 50 分钟，衔接窗口 3h10m，下车直奔城际候车厅",
          "play_intro": "若改签到傍晚航班，兰州的牛肉面和中山桥值得留半天"
        },
        "geo": {
          "verdict": "mainstream",
          "ratio": 1.08,
          "extraKm": 171,
          "estExtraHours": 0,
          "conclusion": null
        }
      },
      {
        "id": "p-cdwl-2",
        "type": "plan",
        "from": "成都",
        "to": "乌鲁木齐",
        "totalTime": "总 37h21m",
        "price": "¥492",
        "priceMid": 492,
        "saved": "省 ¥718",
        "modes": [
          "train"
        ],
        "stops": [
          {
            "name": "成都",
            "sub": "19:58"
          },
          {
            "name": "乌鲁木齐",
            "sub": "D3 09:19"
          }
        ],
        "segs": [
          {
            "mode": "train",
            "dur": "37h21m",
            "fromStation": "成都西",
            "toStation": "乌鲁木齐",
            "dep": "19:58",
            "arr": "09:19",
            "arrNote": "次日",
            "price": "¥492"
          }
        ],
        "risks": [
          {
            "title": "行李直挂",
            "level": "低",
            "lines": [
              "全程火车，随身带上车"
            ]
          },
          {
            "title": "退改规则",
            "level": "中",
            "lines": [
              "票源紧张，退票后可能买不到原班次"
            ]
          },
          {
            "title": "长途硬卧提示",
            "level": "中",
            "lines": [
              "全程约 37 小时，备足干粮、水和充电宝",
              "夜间经停站多，贵重物品贴身放"
            ]
          }
        ],
        "play": null,
        "ai": {
          "summary": "硬卧一觉接一觉，¥492 直达乌鲁木齐，比直飞省 ¥718",
          "fit": "适合时间大把、预算极紧的背包客；全程 37h21m，怕久坐慎选",
          "notice": "进疆长线卧铺紧张，旺季退票后未必买得回原班次，定好行程再出票",
          "play_intro": "把长途当体验：过了嘉峪关，车窗外就是戈壁与风车"
        },
        "geo": {
          "verdict": "mainstream",
          "ratio": 1,
          "extraKm": 0,
          "estExtraHours": 0,
          "conclusion": null
        }
      }
    ]
  },
  "南京-喀什": {
    "direct": {
      "price": "¥1,400",
      "time": "6h15m",
      "note": "直飞基准 · 南京 ⇄ 喀什"
    },
    "plans": [
      {
        "id": "p-njks-1",
        "type": "plan",
        "from": "南京",
        "to": "喀什",
        "totalTime": "总 21h21m",
        "price": "¥862–1,262",
        "priceMid": 1062,
        "saved": "省 ¥338",
        "modes": [
          "train",
          "plane"
        ],
        "stops": [
          {
            "name": "南京",
            "sub": "21:19"
          },
          {
            "name": "西安",
            "sub": "停 4h36m"
          },
          {
            "name": "喀什",
            "sub": "D2 18:40"
          }
        ],
        "segs": [
          {
            "mode": "train",
            "dur": "12h00m",
            "fromStation": "南京",
            "toStation": "西安",
            "dep": "21:19",
            "arr": "09:19",
            "arrNote": "次日",
            "price": "¥262"
          },
          {
            "mode": "plane",
            "dur": "4h45m",
            "fromStation": "西安咸阳T5",
            "toStation": "喀什徕宁T2",
            "dep": "13:55",
            "arr": "18:40",
            "price": "¥600–¥1,000"
          }
        ],
        "risks": [
          {
            "title": "衔接时间余量 · 西安 4h36m",
            "level": "中",
            "lines": [
              "扣除接驳与缓冲后余量约 2 小时",
              "早班机前有 4 个多小时余量，可从容吃碗羊肉泡馍再去机场"
            ]
          },
          {
            "title": "行李不直挂",
            "level": "中",
            "lines": [
              "火车转飞机需自行提取并重新托运",
              "建议预留 30 分钟"
            ]
          },
          {
            "title": "退改规则",
            "level": "中",
            "lines": [
              "机票段为特价舱，改期费较高",
              "火车票开车前可退"
            ]
          },
          {
            "title": "接驳 · 跨站/机场",
            "level": "高",
            "lines": [
              "西安站 → 咸阳机场 40 公里，接驳 70 分钟",
              "机场大巴约 1 小时，早高峰留足 1.5 小时"
            ]
          }
        ],
        "play": {
          "city": "西安",
          "lines": [
            "硬卧一觉到西安，出站先吃羊肉泡馍",
            "如果时间充裕，钟鼓楼回民街值得半日游",
            "春秋为廉航，随身行李尺寸提前确认"
          ]
        },
        "ai": {
          "summary": "夜卧铺到西安，午班机飞喀什，比直飞省 ¥338",
          "fit": "适合预算敏感、能睡卧铺的背包客；想当日达的选直飞或飞机+飞机",
          "notice": "西安站到咸阳机场 40 公里，机场大巴约 70 分钟，衔接窗口 4h36m，别在市区多逗留",
          "play_intro": "若改签到傍晚航班，西安的城墙骑行和回民街小吃值得留一晚"
        },
        "geo": {
          "verdict": "mainstream",
          "ratio": 1,
          "extraKm": 7,
          "estExtraHours": 0,
          "conclusion": null
        }
      },
      {
        "id": "p-njks-2",
        "type": "plan",
        "from": "南京",
        "to": "喀什",
        "totalTime": "总 11h05m",
        "price": "¥1,085–1,485",
        "priceMid": 1285,
        "saved": "省 ¥115",
        "modes": [
          "plane"
        ],
        "stops": [
          {
            "name": "南京",
            "sub": "07:35"
          },
          {
            "name": "西安",
            "sub": "停 4h20m"
          },
          {
            "name": "喀什",
            "sub": "18:40"
          }
        ],
        "segs": [
          {
            "mode": "plane",
            "dur": "2h00m",
            "fromStation": "南京禄口T2",
            "toStation": "西安咸阳T5",
            "dep": "07:35",
            "arr": "09:35",
            "price": "¥485"
          },
          {
            "mode": "plane",
            "dur": "4h45m",
            "fromStation": "西安咸阳T5",
            "toStation": "喀什徕宁T2",
            "dep": "13:55",
            "arr": "18:40",
            "price": "¥600–¥1,000"
          }
        ],
        "risks": [
          {
            "title": "衔接时间余量 · 西安 4h20m",
            "level": "低",
            "lines": [
              "同站换乘，余量充足",
              "同航站楼 T5，衔接 4 小时 20 分，西安机场 MCT 60 分钟，余量充足"
            ]
          },
          {
            "title": "行李不直挂",
            "level": "中",
            "lines": [
              "火车转飞机需自行提取并重新托运",
              "两段廉航/不同航司，大概率无行李直挂，需提取再托运"
            ]
          },
          {
            "title": "退改规则",
            "level": "中",
            "lines": [
              "机票段为特价舱，改期费较高",
              "折扣舱退改费用高，确定行程后再出票"
            ]
          },
          {
            "title": "接驳 · 站内换乘",
            "level": "低",
            "lines": [
              "西安咸阳 T5 航站楼内，无需出站"
            ]
          }
        ],
        "play": null,
        "ai": {
          "summary": "早班机到西安转午班机，比直飞省 ¥115，用时更短",
          "fit": "适合想省时间、能接受早起的背包客；行李多慎选两段托运",
          "notice": "同一航站楼内中转，衔接窗口 4h20m，下机后先确认第二程登机口",
          "play_intro": "中转时间足够吃碗油泼面，航站楼里有陕西小吃街"
        },
        "geo": {
          "verdict": "mainstream",
          "ratio": 1,
          "extraKm": 7,
          "estExtraHours": 0,
          "conclusion": null
        }
      }
    ]
  }
};

  var TEMPLATES = [
  {
    "id": "tpl-001",
    "type": "tpl",
    "from": "北京",
    "to": "喀什",
    "totalTime": "总 23h17m",
    "price": "¥1,185",
    "priceMid": 1185,
    "saved": "省 ¥1,295",
    "modes": [
      "train",
      "plane"
    ],
    "stops": [
      {
        "name": "北京",
        "sub": "21:30"
      },
      {
        "name": "银川",
        "sub": "停 1h53m"
      },
      {
        "name": "阿克苏",
        "sub": "停 1h40m"
      },
      {
        "name": "喀什",
        "sub": "D2 20:47"
      }
    ],
    "segs": [
      {
        "mode": "train",
        "dur": "10h42m",
        "fromStation": "北京西",
        "toStation": "银川",
        "dep": "21:30",
        "arr": "08:12",
        "arrNote": "次日",
        "price": "¥263"
      },
      {
        "mode": "plane",
        "dur": "3h35m",
        "fromStation": "银川河东",
        "toStation": "阿克苏",
        "dep": "10:05",
        "arr": "13:40",
        "price": "¥780–¥920"
      },
      {
        "mode": "train",
        "dur": "5h27m",
        "fromStation": "阿克苏",
        "toStation": "喀什",
        "dep": "15:20",
        "arr": "20:47",
        "price": "¥72"
      }
    ],
    "risks": [
      {
        "title": "衔接时间余量 · 银川 1h53m",
        "level": "高",
        "lines": [
          "跨站接驳后余量不足 1 小时",
          "误机将错过每日 2 班的航班"
        ]
      },
      {
        "title": "行李不直挂",
        "level": "中",
        "lines": [
          "火车转飞机需自行提取并重新托运",
          "建议预留 30 分钟"
        ]
      },
      {
        "title": "退改规则",
        "level": "低",
        "lines": [
          "机票段为 4 折以上舱位，可改期",
          "火车票开车前可退"
        ]
      },
      {
        "title": "接驳 · 跨站/机场",
        "level": "中",
        "lines": [
          "银川站 → 河东机场 18 公里，接驳 40 分钟"
        ]
      }
    ],
    "play": {
      "city": "银川",
      "lines": [
        "若改签到次日航班",
        "镇北堡西部影城（市区打车 40 分钟）",
        "怀远夜市（人均 ¥35 吃撑）",
        "当地物价：住宿 ¥90–150/晚",
        "机场巴士 ¥20"
      ]
    },
    "ai": {
      "summary": "火车混搭飞机，比直飞省 ¥1,295，银川中转还能逛夜市",
      "fit": "适合时间相对充裕、想大幅压预算的背包客；行李多的话要掂量转运",
      "notice": "银川转机窗口 1h53m，下火车直接奔机场巴士，别在市区逗留",
      "play_intro": "若改签到次日航班，镇北堡西部影城和怀远夜市值得专门留一晚"
    },
    "badge": "官方精调",
    "region": "西部",
    "contributor": "@大漠孤烟",
    "rating": 4.8,
    "walkers": 12,
    "img": "../assets/route-kashgar.jpg",
    "desc": "火车混搭飞机，省 ¥1,295，银川中转可玩"
  },
  {
    "id": "tpl-002",
    "type": "tpl",
    "from": "北京",
    "to": "乌鲁木齐",
    "totalTime": "总 31h09m",
    "price": "¥890",
    "priceMid": 890,
    "saved": "省 ¥760",
    "modes": [
      "train"
    ],
    "stops": [
      {
        "name": "北京",
        "sub": "17:56"
      },
      {
        "name": "兰州",
        "sub": "停 2h15m"
      },
      {
        "name": "乌鲁木齐",
        "sub": "D3 01:05"
      }
    ],
    "segs": [
      {
        "mode": "train",
        "dur": "17h05m",
        "fromStation": "北京西",
        "toStation": "兰州",
        "dep": "17:56",
        "arr": "11:01",
        "arrNote": "次日",
        "price": "¥363"
      },
      {
        "mode": "train",
        "dur": "11h49m",
        "fromStation": "兰州西",
        "toStation": "乌鲁木齐",
        "dep": "13:16",
        "arr": "01:05",
        "arrNote": "次日",
        "price": "¥527"
      }
    ],
    "risks": [
      {
        "title": "衔接时间余量 · 兰州 2h15m",
        "level": "中",
        "lines": [
          "扣除接驳与缓冲后余量约 1.5 小时",
          "到达兰州站、出发兰州西站，需跨站"
        ]
      },
      {
        "title": "行李直挂",
        "level": "低",
        "lines": [
          "全程火车，随身带上车",
          "无需中途托运"
        ]
      },
      {
        "title": "退改规则",
        "level": "低",
        "lines": [
          "均为火车票，开车前可退"
        ]
      },
      {
        "title": "接驳 · 跨站/机场",
        "level": "中",
        "lines": [
          "兰州站 → 兰州西站 10 公里，轨交 25 分钟",
          "行李多建议打车约 ¥20"
        ]
      }
    ],
    "play": {
      "city": "兰州",
      "lines": [
        "换乘间隙吃碗牛肉面再走",
        "兰州西站候车厅有免费充电区",
        "进疆列车昼夜温差大，备件外套"
      ]
    },
    "ai": {
      "summary": "兰新线一路向西，全程火车省 ¥760，卧铺一晚到",
      "fit": "适合想看河西走廊风景、不赶时间的人；要在兰州跨站换车",
      "notice": "兰州站换兰州西站，地铁 25 分钟直达，2h15m 的余量不用慌",
      "play_intro": "换乘间隙去正宁路吃碗面，回站前留好地铁时间"
    },
    "badge": "官方精调",
    "region": "西部",
    "contributor": "@西域行者",
    "rating": 4.6,
    "walkers": 8,
    "img": "../assets/route-urumqi.jpg",
    "desc": "兰新线直达，省 ¥760，衔接风险低"
  },
  {
    "id": "tpl-003",
    "type": "tpl",
    "from": "上海",
    "to": "昆明",
    "totalTime": "总 13h45m",
    "price": "¥720",
    "priceMid": 720,
    "saved": "省 ¥540",
    "modes": [
      "train"
    ],
    "stops": [
      {
        "name": "上海",
        "sub": "08:35"
      },
      {
        "name": "贵阳",
        "sub": "停 2h12m"
      },
      {
        "name": "昆明",
        "sub": "22:20"
      }
    ],
    "segs": [
      {
        "mode": "train",
        "dur": "9h05m",
        "fromStation": "上海虹桥",
        "toStation": "贵阳北",
        "dep": "08:35",
        "arr": "17:40",
        "price": "¥508"
      },
      {
        "mode": "train",
        "dur": "2h28m",
        "fromStation": "贵阳北",
        "toStation": "昆明南",
        "dep": "19:52",
        "arr": "22:20",
        "price": "¥212"
      }
    ],
    "risks": [
      {
        "title": "衔接时间余量 · 贵阳 2h12m",
        "level": "低",
        "lines": [
          "同站换乘，余量充足",
          "误车风险低"
        ]
      },
      {
        "title": "行李直挂",
        "level": "低",
        "lines": [
          "全程火车，随身带上车",
          "无需中途托运"
        ]
      },
      {
        "title": "退改规则",
        "level": "中",
        "lines": [
          "票源紧张，退票后可能买不到原班次",
          "高铁票开车前可退"
        ]
      },
      {
        "title": "接驳 · 站内换乘",
        "level": "低",
        "lines": [
          "贵阳北站内换乘，无需出站"
        ]
      }
    ],
    "play": {
      "city": "贵阳",
      "lines": [
        "2 小时够在站内吃个丝娃娃",
        "甲秀楼夜景（打车 25 分钟）",
        "贵阳北站行李寄存 ¥15/件"
      ]
    },
    "ai": {
      "summary": "全程高铁坐着到昆明，省 ¥540，贵阳站内换乘",
      "fit": "适合不想折腾行李、追求稳妥的人",
      "notice": "贵阳北换乘通道步行约 12 分钟，2h12m 足够吃口饭",
      "play_intro": "间隙试试站内丝娃娃，或者打车去看甲秀楼"
    },
    "badge": "官方精调",
    "region": "西南",
    "contributor": "@春城慢游",
    "rating": 4.5,
    "walkers": 6,
    "img": "../assets/route-kunming.jpg",
    "desc": "贵阳中转，省 ¥540，中转城市可玩"
  },
  {
    "id": "tpl-004",
    "type": "tpl",
    "from": "广州",
    "to": "三亚",
    "totalTime": "总 15h18m",
    "price": "¥404",
    "priceMid": 404,
    "saved": "省 ¥549",
    "modes": [
      "train"
    ],
    "stops": [
      {
        "name": "广州",
        "sub": "21:16"
      },
      {
        "name": "海口",
        "sub": "停 2h05m"
      },
      {
        "name": "三亚",
        "sub": "D2 12:34"
      }
    ],
    "segs": [
      {
        "mode": "train",
        "dur": "11h26m",
        "fromStation": "广州",
        "toStation": "海口",
        "dep": "21:16",
        "arr": "08:42",
        "arrNote": "次日",
        "price": "¥296"
      },
      {
        "mode": "train",
        "dur": "1h47m",
        "fromStation": "海口",
        "toStation": "三亚",
        "dep": "10:47",
        "arr": "12:34",
        "price": "¥108"
      }
    ],
    "risks": [
      {
        "title": "衔接时间余量 · 海口 2h05m",
        "level": "低",
        "lines": [
          "同站换乘，余量充足",
          "同站换乘环岛高铁，可出站透气"
        ]
      },
      {
        "title": "行李直挂",
        "level": "低",
        "lines": [
          "全程火车，随身带上车",
          "轮渡段不卸行李"
        ]
      },
      {
        "title": "退改规则",
        "level": "低",
        "lines": [
          "均为火车票，开车前可退"
        ]
      },
      {
        "title": "接驳 · 站内换乘",
        "level": "低",
        "lines": [
          "海口站同站换乘，无需出站"
        ]
      },
      {
        "title": "轮渡段提示",
        "level": "中",
        "lines": [
          "火车拆装上船，夜间过海约 3 小时",
          "过海段空调暂停，夏季备小风扇"
        ]
      }
    ],
    "play": {
      "city": "海口",
      "lines": [
        "骑楼老街喝老爸茶（人均 ¥15）",
        "海口站 → 市区公交 40 分钟",
        "轮渡段在甲板看日出，值回票价"
      ]
    },
    "ai": {
      "summary": "火车坐轮渡过海，¥404 到三亚，体验独一份",
      "fit": "适合想打卡海上火车、预算优先的人；怕闷怕热慎选夏季",
      "notice": "夜间过海空调暂停，备小风扇和水；海口换乘 2h05m 很宽裕",
      "play_intro": "海口间隙去骑楼老街喝老爸茶，轮渡甲板日出别睡过"
    },
    "badge": "官方精调",
    "region": "海南",
    "contributor": "@椰风海韵",
    "rating": 4.7,
    "walkers": 9,
    "desc": "火车坐轮渡过海，省 ¥549，体验独一份"
  },
  {
    "id": "tpl-005",
    "type": "tpl",
    "from": "北京",
    "to": "哈尔滨",
    "totalTime": "总 10h02m",
    "price": "¥604",
    "priceMid": 604,
    "saved": "省 ¥546",
    "modes": [
      "train"
    ],
    "stops": [
      {
        "name": "北京",
        "sub": "08:00"
      },
      {
        "name": "沈阳",
        "sub": "停 4h20m"
      },
      {
        "name": "哈尔滨",
        "sub": "18:02"
      }
    ],
    "segs": [
      {
        "mode": "train",
        "dur": "3h14m",
        "fromStation": "北京朝阳",
        "toStation": "沈阳北",
        "dep": "08:00",
        "arr": "11:14",
        "price": "¥357"
      },
      {
        "mode": "train",
        "dur": "2h28m",
        "fromStation": "沈阳北",
        "toStation": "哈尔滨西",
        "dep": "15:34",
        "arr": "18:02",
        "price": "¥247"
      }
    ],
    "risks": [
      {
        "title": "衔接时间余量 · 沈阳 4h20m",
        "level": "低",
        "lines": [
          "同站换乘，余量充足",
          "可出站到市区逛一圈"
        ]
      },
      {
        "title": "行李直挂",
        "level": "低",
        "lines": [
          "全程火车，随身带上车",
          "车站寄存 ¥10/件"
        ]
      },
      {
        "title": "退改规则",
        "level": "低",
        "lines": [
          "均为火车票，开车前可退",
          "开车前均可退改"
        ]
      },
      {
        "title": "接驳 · 站内换乘",
        "level": "低",
        "lines": [
          "沈阳北站同站换乘，无需出站",
          "地铁 2 号线直达市区"
        ]
      }
    ],
    "play": {
      "city": "沈阳",
      "lines": [
        "沈阳故宫（地铁 1 号线，逛 2 小时）",
        "中街老边饺子（人均 ¥45）",
        "4 小时中转刚好半日游"
      ]
    },
    "ai": {
      "summary": "沈阳中转玩半天再北上，省 ¥546，行程不赶路",
      "fit": "适合第一次去东北、想把中转变景点的人；全程高铁很稳",
      "notice": "沈阳 4h20m 刚好半日游，回站前看好时间",
      "play_intro": "沈阳故宫加中街老边饺子，是中转的标准打开方式"
    },
    "badge": "官方精调",
    "region": "东北",
    "contributor": "@北国风光",
    "rating": 4.6,
    "walkers": 11,
    "desc": "沈阳中转玩半天，省 ¥546，行程不赶路"
  },
  {
    "id": "tpl-006",
    "type": "tpl",
    "from": "成都",
    "to": "拉萨",
    "totalTime": "总 40h11m",
    "price": "¥797",
    "priceMid": 797,
    "saved": "省 ¥883",
    "modes": [
      "train"
    ],
    "stops": [
      {
        "name": "成都",
        "sub": "21:37"
      },
      {
        "name": "西宁",
        "sub": "停 4h51m"
      },
      {
        "name": "拉萨",
        "sub": "D3 13:48"
      }
    ],
    "segs": [
      {
        "mode": "train",
        "dur": "14h32m",
        "fromStation": "成都西",
        "toStation": "西宁",
        "dep": "21:37",
        "arr": "12:09",
        "arrNote": "次日",
        "price": "¥302"
      },
      {
        "mode": "train",
        "dur": "20h48m",
        "fromStation": "西宁",
        "toStation": "拉萨",
        "dep": "17:00",
        "arr": "13:48",
        "arrNote": "次日",
        "price": "¥495"
      }
    ],
    "risks": [
      {
        "title": "衔接时间余量 · 西宁 4h51m",
        "level": "低",
        "lines": [
          "同站换乘，余量充足",
          "可在市区吃顿手抓羊肉"
        ]
      },
      {
        "title": "行李直挂",
        "level": "低",
        "lines": [
          "全程火车，随身带上车",
          "进藏车有氧舱"
        ]
      },
      {
        "title": "退改规则",
        "level": "中",
        "lines": [
          "票源紧张，退票后可能买不到原班次",
          "火车票开车前可退"
        ]
      },
      {
        "title": "接驳 · 站内换乘",
        "level": "低",
        "lines": [
          "西宁站同站换乘，无需出站"
        ]
      },
      {
        "title": "高原提示",
        "level": "中",
        "lines": [
          "格尔木后海拔超 4000m",
          "提前备红景天，车上少剧烈活动"
        ]
      }
    ],
    "play": {
      "city": "西宁",
      "lines": [
        "莫家街酿皮酸奶（人均 ¥25）",
        "塔尔寺半日（打车 40 分钟）",
        "西宁 → 拉萨段建议提前 15 天购票"
      ]
    },
    "ai": {
      "summary": "西宁换车渐进上高原，省 ¥883，高反更友好",
      "fit": "适合首次进藏、想逐步适应海拔的人；旺季票紧，要早订",
      "notice": "进藏段建议提前十五天购票；格尔木后海拔高，车上少剧烈活动",
      "play_intro": "西宁间隙去莫家街吃酿皮酸奶，塔尔寺半日也来得及"
    },
    "badge": "官方精调",
    "region": "西部",
    "contributor": "@高原雄鹰",
    "rating": 4.9,
    "walkers": 15,
    "desc": "西宁换车渐进上高原，省 ¥883，高反更友好"
  }
];

  /* ---------- 查找辅助 ---------- */

  function findPlan(id) {
    for (var key in ROUTES) {
      var plans = ROUTES[key].plans;
      for (var i = 0; i < plans.length; i++) {
        if (plans[i].id === id) return plans[i];
      }
    }
    return null;
  }

  function findTemplate(id) {
    for (var i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].id === id) return TEMPLATES[i];
    }
    return null;
  }

  window.DB = {
    cities: CITIES,
    routes: ROUTES,
    templates: TEMPLATES,
    findPlan: findPlan,
    findTemplate: findTemplate,
    findItem: function (id) { return findPlan(id) || findTemplate(id); }
  };
})();
